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

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing herdsman');
                return;
            }

            this.models = new Map();
            this.herdsman = shepherdNode.herdsman;
            this.ieeeAddresses = {};
            this.names = {};

            /*
            const groupConverters = [
                herdsmanConverters.toZigbeeConverters.light_onoff_brightness,
                herdsmanConverters.toZigbeeConverters.light_colortemp,
                herdsmanConverters.toZigbeeConverters.light_color,
                herdsmanConverters.toZigbeeConverters.light_alert,
                herdsmanConverters.toZigbeeConverters.ignore_transition
            ];
            */

            const devicesHandler = () => {
                const devices = this.herdsman.getDevices();
                devices.forEach(device => {
                    this.ieeeAddresses[device.ieeeAddr] = device;
                    this.names[device.meta.name] = device;
                });
            };

            this.on('input', msg => {
                const topic = (msg.topic || '').split('/');
                const settopic = (config.settopic || '').split('/');
                const gettopic = (config.gettopic || '').split('/');
                const settopicAttrs = {};
                const gettopicAttrs = {};
                let topicAttrs;

                let isGet = true;
                let isSet = true;

                for (const [i, element] of topic.entries()) {
                    const setmatch = settopic[i].match(/\${([^}]+)}/);
                    if (setmatch) {
                        settopicAttrs[setmatch[1]] = element;
                    } else if (element !== settopic[i]) {
                        isSet = false;
                    }

                    const getmatch = gettopic[i].match(/\${([^}]+)}/);
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

                this.debug('topic=' + msg.topic + ' name=' + name + ' ieeeAddr=' + ieeeAddr + ' attribute=' + attribute + ' payload=' + JSON.stringify(msg.payload));

                if (!device) {
                    this.error('device unknown ' + name + ' ' + ieeeAddr);
                    return;
                }

                let model;
                // Map device to a model
                if (this.models.has(device.modelID)) {
                    model = this.models.get(device.modelID);
                } else {
                    model = herdsmanConverters.findByZigbeeModel(device.modelID);
                    this.models.set(device.modelID, model);
                }

                if (!model) {
                    this.warn(`Device with modelID '${device.modelID}' is not supported.`);
                    this.warn('Please see: https://koenkk.github.io/zigbee2mqtt/how_tos/how_to_support_new_devices.html');
                    return;
                }

                /*
                // TODO understand postfix
                let endpoint;
                // Determine endpoint to publish to.
                if (model.hasOwnProperty('endpoint')) {
                    const eps = model.endpoint(device);
                    endpoint = eps.hasOwnProperty(isSet ? 'set' : 'get') ? eps[isSet ? 'set' : 'get'] : null;
                    if (endpoint === null && eps.hasOwnProperty('default')) {
                        endpoint = eps['default'];
                    }
                }
                console.log('determined endpoint', endpoint);
                */

                let payload;

                if (attribute) {
                    payload = {};
                    payload[attribute] = msg.payload;
                } else if (typeof msg.payload === 'object') {
                    payload = msg.payload;
                } else if (typeof msg.payload === 'string') {
                    // No attribute supplied, payload not an object - assume state.
                    payload = {state: msg.payload};
                } else {
                    payload = {state: msg.payload ? 'ON' : 'OFF'};
                }

                // For each key in the JSON message find the matching converter.
                Object.keys(payload).forEach(key => {
                    const converter = model.toZigbee.find(c => c.key.includes(key));
                    if (!converter) {
                        this.error(`No converter available for '${key}' (${payload[key]})`);
                        return;
                    }

                    if (isSet) {
                        // TODO gain understanding of endpoints. Currently just using the first one due to missing knowledge.
                        converter.convertSet(device.endpoints[0], key, payload[key], {message: payload, options: {}}).then(result => {
                            shepherdNode.reachable(device, true);
                            // TODO handle readAfterWrite
                            // TODO output new state
                            this.debug(`${device.ieeeAddr} ${device.meta.name} ${JSON.stringify(result)}`);
                        }).catch(err => {
                            this.error(`${device.ieeeAddr} ${device.meta.name} ${err.message}`);
                            shepherdNode.reachable(device, false);
                        });
                    } else if (isGet) {
                        converter.convertGet(device.endpoints[0], key, payload[key], {message: payload, options: {}}).then(result => {
                            shepherdNode.reachable(device, true);
                            this.debug(`${device.ieeeAddr} ${device.meta.name} ${JSON.stringify(result)}`);
                        }).catch(err => {
                            this.error(`${device.ieeeAddr} ${device.meta.name} ${err.message}`);
                            shepherdNode.reachable(device, false);
                        });
                    }
                });
            });

            const messageHandler = data => {
                const {device} = data;

                if (config.device && config.device !== device.ieeeAddr) {
                    return;
                }

                const out = {
                    topic: null,
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

                let model;
                // Map device to a model
                if (this.models.has(device.modelID)) {
                    model = this.models.get(device.modelID);
                } else {
                    model = herdsmanConverters.findByZigbeeModel(device.modelID);
                    this.models.set(device.modelID, model);
                }

                const hasGroupID = data.groupID;
                if (utils.isXiaomiDevice(data.device) && utils.isRouter(data.device) && hasGroupID) {
                    this.debug('Skipping re-transmitted Xiaomi message');
                    return;
                }

                if (data.device.modelID === null && data.device.interviewing) {
                    this.debug('Skipping message, modelID is undefined and still interviewing');
                    return;
                }

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
                    if (data.type !== 'readResponse') {
                        this.warn(
                            `No converter available for '${data.device.modelID}' with cluster '${data.cluster}' ` +
                            `and type '${data.type}' and data '${JSON.stringify(data.data)}'`
                        );
                        this.warn('Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html.');
                    }

                    return;
                }

                let wait = converters.length;

                const publish = convertedPayload => {
                    wait -= 1;
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
                        Object.assign(out.payload, convertedPayload);
                        if (wait === 0) {
                            if (typeof data.linkquality !== 'undefined') {
                                out.payload.linkquality = data.linkquality;
                            }

                            this.send(out);
                        }
                    }
                };

                converters.forEach(converter => {
                    const convertedPayload = converter.convert(model, data, publish, {});
                    if (convertedPayload && Object.keys(convertedPayload).length > 0) {
                        publish(convertedPayload);
                    }
                });
            };

            const nodeStatusHandler = status => {
                this.status(status);
            };

            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('message', messageHandler);
            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('ready', devicesHandler);
            shepherdNode.proxy.on('devices', devicesHandler);

            this.on('close', () => {
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('message', messageHandler);
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('ready', devicesHandler);
                shepherdNode.proxy.removeListener('devices', devicesHandler);
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
