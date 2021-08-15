const herdsmanConverters = require('zigbee-herdsman-converters');
const utils = require('../lib/utils.js');

module.exports = function (RED) {
    RED.httpAdmin.get('/zigbee-shepherd/converters', RED.auth.needsPermission('zigbee.read'), (req, res) => {
        const converters = herdsmanConverters.findByZigbeeModel(req.query.modelID);
        res.status(200).send(JSON.stringify({supports: converters.supports || ''}));
    });

    class ZigbeeConverter {
        constructor(config) {
            RED.nodes.createNode(this, config);

            this.shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!this.shepherdNode) {
                this.error('missing herdsman');
                return;
            }

            this.models = new Map();
            
            this.herdsman = this.shepherdNode.herdsman;
            this.ieeeAddresses = {};
            this.names = {};

            const groupConverters = [
                herdsmanConverters.toZigbeeConverters.light_onoff_brightness,
                herdsmanConverters.toZigbeeConverters.light_colortemp,
                herdsmanConverters.toZigbeeConverters.light_color,
                herdsmanConverters.toZigbeeConverters.light_alert,
                herdsmanConverters.toZigbeeConverters.ignore_transition
            ];

            const getDevices = () => {
                this.trace('getDevices');
                const devices = this.herdsman.getDevices();
                devices.forEach(device => {
                    this.ieeeAddresses[device.ieeeAddr] = device;
                    this.names[device.meta.name] = device;
                });
                this.groups = this.herdsman.getGroups();
                this.gotDevices = true;
            };

            const readyHandler = () => {
                this.trace('readyHandler');
                if (!this.gotDevices) {
                    getDevices();
                }
            };

            const devicesHandler = () => {
                this.trace('devicesHandler');
                getDevices();
            };

            this.on('input', (msg, send, done) => {
                if (!done) {
                    done = err => {
                        if (err) {
                            this.error(err.message);
                        }
                    };
                }

                const topic = (msg.topic || '').split('/');
                const settopic = (config.settopic || '').split('/');
                const gettopic = (config.gettopic || '').split('/');
                const settopicAttrs = {};
                const gettopicAttrs = {};
                let topicAttrs;

                let isGet = true;
                let isSet = true;
                let isGroup = false;

                for (const [i, element] of topic.entries()) {
                    const setmatch = String(settopic[i]).match(/\${([^}]+)}/);
                    if (setmatch) {
                        settopicAttrs[setmatch[1]] = element;
                    } else if (element !== settopic[i]) {
                        isSet = false;
                    }

                    const getmatch = String(gettopic[i]).match(/\${([^}]+)}/);
                    if (getmatch) {
                        gettopicAttrs[getmatch[1]] = element;
                    } else if (element !== gettopic[i]) {
                        isGet = false;
                    }
                }

                if (isSet) {
                    topicAttrs = settopicAttrs;
                } else if (isGet) {
                    topicAttrs = gettopicAttrs;
                } else {
                    this.warn('topic mismatch ' + msg.topic);
                    return;
                }

                // TODO group support

                const ieeeAddr = config.device || topicAttrs.ieeeAddr || (topicAttrs.name && this.names[topicAttrs.name] && this.names[topicAttrs.name].ieeeAddr);
                const device = this.ieeeAddresses[ieeeAddr];
                const name = topicAttrs.name || (device && device.meta.name);
                const attribute = config.attribute || topicAttrs.attribute;
                let group;
                this.debug('topic=' + msg.topic + ' name=' + name + ' ieeeAddr=' + ieeeAddr + ' attribute=' + attribute + ' payload=' + JSON.stringify(msg.payload));

                if (!device) {
                    group = this.groups && this.groups.find(g => g.meta.name === topicAttrs.name);
                    if (group) {
                        isGroup = true;
                    } else {
                        this.error('device unknown ' + name + ' ' + ieeeAddr);
                        return;
                    }
                }

                let model;
                let converters;

                if (isGroup) {
                    converters = groupConverters;
                } else {
                    model = this.getModelFromDevice(device);
                    if (!model) {
                        this.warn(`Device with modelID '${device.modelID}' is not supported.`);
                        this.warn('Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html');
                        return;
                    }

                    converters = model.toZigbee;
                }

                // TODO understand postfix
                let endpoint = this.getEndPointFromDevice(model, device, isSet);
                let payload = this.getPayloadFromMsg(msg, attribute);

                // For each key in the JSON message find the matching converter.
                Object.keys(payload).sort(a => (['state', 'brightness'].includes(a) ? -1 : 1)).forEach(key => {
                    const converter = converters.find(c => c.key.includes(key));
                    if (!converter) {
                        this.error(`No converter available for '${key}' (${payload[key]}) on  modelID '${device.modelID}'`);
                        return;
                    }
                    const meta = {
                        options: {},
                        message: payload,
                        mapped: model,
                        state: {},
                        logger: {
                            debug: console.debug,
                            log: console.log,
                            info: console.log,
                            warn: console.warn,
                            error: console.error
                        }
                    };
                    if (isSet) {
                        if(isGroup) {
                            this.setToGroup(converter, group, key, payload, meta, done);
                        }
                        else {
                            this.setToDevice(converter, endpoint, key, payload, meta, device, done);
                        }                     
                    } else { //get
                        this.getFromDevice(converter, device, payload, endpoint, key, meta, done);
                    }
                });
            });

            const messageHandler = data => {
                const {device} = data;

                if (config.device && config.device !== device.ieeeAddr) {
                    return;
                }

                if (utils.isXiaomiDevice(data.device) && utils.isRouter(data.device) && data.groupID) {
                    this.debug('Skipping re-transmitted Xiaomi message');
                    return;
                }

                if (data.device.modelID === null && data.device.interviewing) {
                    this.debug('Skipping message, modelID is undefined and still interviewing');
                    return;
                }

                let model = this.getModelFromDevice(device);
                if (!model) {
                    this.warn(`Received message from unsupported device with Zigbee model '${data.device.modelID}'`);
                    this.warn('Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html.');
                    return;
                }

                // Find a converter for this message.
                const converters = model.fromZigbee.filter(c => {
                    const type = Array.isArray(c.type) ? c.type.includes(data.type) : c.type === data.type;
                    return c.cluster === data.cluster && type;
                });

                // Check if there is an available converter
                if (converters.length === 0) {
                    // Don't log readRsp messages, they are not interesting most of the time.
                    // Todo: Clarify genOta logging (#107)
                    if (data.type !== 'readResponse' && data.cluster !== 'genOta') {
                        this.warn(
                            `No converter available for '${data.device.modelID}' with cluster '${data.cluster}' ` +
                            `and type '${data.type}' and data '${JSON.stringify(data.data)}'`
                        );
                        this.warn('Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html.');
                    }
                    return;
                }

                let wait = converters.length;

                const out = {
                    topic: config.topic,
                    payload: {},
                    name: device.meta.name,
                    type: device.type,
                    manufacturerName: device.manufacturerName,
                    modelID: device.modelID,
                    lastSeen: device.lastSeen,
                    ieeeAddr: device.ieeeAddr,
                    data: data.data,
                    linkquality: data.linkquality,
                    groupID: data.groupID,
                    cluster: data.cluster
                };
                out.topic = this.topicReplace(config.topic, out);
                const publish = convertedPayload => {
                    if (config.payload === 'plain') {
                        Object.keys(convertedPayload).forEach(key => {
                            if (config.attribute === '' || config.attribute === key) {
                                const msg = {...out, topic: out.topic + '/' + key,
                                    payload: convertedPayload[key],
                                    retain: !['click', 'action', 'angle'].includes(key)};
                                this.send(msg);
                            }
                        });
                    } else {
                        // indicate out.payload has been  "extended"
                        // with converted data
                        wait -= 1;
                        Object.assign(out.payload, convertedPayload);
                    }
                };
                converters.forEach(converter => {
                    const convertedPayload = converter.convert(model, data, publish, {}, device.meta);
                    if (convertedPayload && Object.keys(convertedPayload).length > 0) {
                        publish(convertedPayload);
                    }
                });

                // if at least one converter produced out.payload data
                // send the combined result
                if (wait < converters.length) {
                    if (typeof data.linkquality !== 'undefined') {
                        out.payload.linkquality = data.linkquality;
                    }

                    this.send(out);
                }
            };

            const nodeStatusHandler = status => {
                this.status(status);
            };

            this.debug('adding event listeners');
            this.shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            this.shepherdNode.proxy.on('message', messageHandler);
            this.shepherdNode.proxy.on('ready', readyHandler);
            this.shepherdNode.proxy.on('devices', devicesHandler);

            if (!this.gotDevices && this.shepherdNode.status === 'connected') {
                getDevices();
            }

            this.on('close', () => {
                this.debug('removing event listeners');
                this.shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                this.shepherdNode.proxy.removeListener('message', messageHandler);
                this.shepherdNode.proxy.removeListener('ready', readyHandler);
                this.shepherdNode.proxy.removeListener('devices', devicesHandler);
                this.gotDevices = false;
            });
        }

        getModelFromDevice(device) {
            if (this.models.has(device.modelID)) {
                return this.models.get(device.modelID);
            } else {
                let model = herdsmanConverters.findByDevice(device);
                this.models.set(device.modelID, model);
                return model;
            }
        }

        getPayloadFromMsg(msg, attribute) {
            if (typeof msg.payload === 'string' && msg.payload.startsWith('{')) {
                try {
                    msg.payload = JSON.parse(msg.payload);
                } catch { }
            }

            let payload;
            if (attribute) {
                payload = {};
                payload[attribute] = msg.payload;
            } else if (typeof msg.payload === 'object') {
                payload = msg.payload;
            } else if (typeof msg.payload === 'string') {
                // No attribute supplied, payload not an object - assume state.
                payload = { state: msg.payload };
            } else {
                payload = { state: msg.payload ? 'ON' : 'OFF' };
            }
            return payload;
        }

        getEndPointFromDevice(model, device, isSet) {
            if (typeof model.endpoint === 'undefined') {
                return device.endpoints[0];
            }
            const endpoints = model.endpoint(device);
            let endpoint = endpoints[isSet ? 'set' : 'get'];
            if((endpoint === null || typeof endpoint === 'undefined') && eps.default !== 'undefined') {
                return eps.default;
            }
            return device.endpoints[0];            
        }

        getFromDevice(converter, device, payload, endpoint, key, meta, done) {
            if (!converter.convertGet) {
                this.error(`Converter can not read '${key}' (${payload[key]}) on  modelID '${device.modelID}'`);
                return;
            }
            converter.convertGet(endpoint, key, meta).then(result => {
                this.handleResult(device, result);
                done();
            }).catch(err => {
                this.handleError(device, err);
            });
        }

        setToDevice(converter, endpoint, key, payload, meta, device, done) {
            converter.convertSet(endpoint, key, payload[key], meta).then(result => {
                this.handleResult(device, result);

                // Todo clarify why converterGet doesnt set readAfterWriteTime when state==OFF
                if (result && typeof result.readAfterWriteTime === 'undefined' && !device.meta.reporting && result.state && result.state.state === 'OFF') {
                    result.readAfterWriteTime = 0;
                }

                if (result && typeof result.readAfterWriteTime !== 'undefined' && !device.meta.reporting) {
                    setTimeout(() => {
                        this.debug(`readAfterWrite ${device.ieeeAddr} ${device.meta.name}`);
                        converter.convertGet(endpoint, key, meta);
                        done();
                    }, result.readAfterWriteTime);
                } else {
                    done();
                }
            }).catch(err => {
                this.error("setToDevice error");
                this.handleError(device, err);
            });
        }

        handleError(device, err) {
            this.shepherdNode.reachable(device, false);
            done(new Error(`${device.ieeeAddr} ${device.meta.name} ${err.message}`));
        }

        handleResult(device, result) {
            this.shepherdNode.reachable(device, true);
            this.debug(`${device.ieeeAddr} ${device.meta.name} ${JSON.stringify(result)}`);
        }

        setToGroup(converter, group, key, payload, meta, done) {
            converter.convertSet(group, key, payload[key], meta).then(result => {
                this.debug(`${group.groupID} ${group.meta.name} ${JSON.stringify(result)}`);
                done();
            }).catch(err => {
                done(new Error(`${group.groupID} ${group.meta.name} ${err.message}`));
            });
        }

        topicReplace(topic, msg) {
            if (!topic || typeof msg !== 'object') {
                return topic;
            }

            const msgLower = {};
            Object.keys(msg).forEach(k => {
                msgLower[k.toLowerCase()] = msg[k];
            });

            const match = topic.match(/\${[^}]+}/g);
            if (match) {
                match.forEach(v => {
                    const key = v.substr(2, v.length - 3);
                    const rx = new RegExp('\\${' + key + '}', 'g');
                    const rkey = key.toLowerCase();
                    topic = topic.replace(rx, msgLower[rkey] || '');
                });
            }

            return topic;
        }
    }

    RED.nodes.registerType('zigbee-converter', ZigbeeConverter);
};