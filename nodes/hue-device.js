const oe = require('obj-ease');
const {zllDevice, uniqueidSuffix, emptyStates} = require('../lib/zll.js');

module.exports = function (RED) {
    class ZigbeeHueDevice {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.herdsman;
            this.proxy = shepherdNode.proxy;
            this.config = config;

            const nodeStatusHandler = status => {
                this.status(status);
            };

            this.lastState = {};

            const getDevices = () => {
                this.trace('getDevices');
                this.devices = shepherdNode.herdsman.getDevices();
                this.groups = shepherdNode.herdsman.getGroups();
                this.devices.forEach(device => {
                    if (device.ieeeAddr === this.device) {
                        this.initLight(device);
                    }
                });
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

            const publishTimeouts = {};

            const messageHandler = message => {
                if (['attributeReport', 'readResponse'].includes(message.type) && message.device.meta.hue) {
                    const {device} = message;

                    device.meta.hue.state.reachable = true;

                    if (message.cluster === 'genOnOff') {
                        device.meta.hue.state.on = Boolean(message.data.onOff);
                    }

                    if (message.cluster === 'genLevelCtrl') {
                        device.meta.hue.state.bri = message.data.currentLevel;
                    }

                    if (message.cluster === 'lightingColorCtrl') {
                        if (typeof message.data.colorTemperature !== 'undefined') {
                            device.meta.hue.state.ct = message.data.colorTemperature;
                        }

                        if (typeof message.data.enhancedCurrentHue !== 'undefined') {
                            device.meta.hue.state.hue = message.data.enhancedCurrentHue;
                        }

                        if (typeof message.data.currentSaturation !== 'undefined') {
                            device.meta.hue.state.sat = message.data.currentSaturation;
                        }

                        if (typeof message.data.currentX !== 'undefined') {
                            if (!device.meta.hue.state.xy) {
                                device.meta.hue.state.xy = [];
                            }

                            device.meta.hue.state.xy[0] = message.data.currentX / 65535;
                        }

                        if (typeof message.data.currentY !== 'undefined') {
                            if (!device.meta.hue.state.xy) {
                                device.meta.hue.state.xy = [];
                            }

                            device.meta.hue.state.xy[1] = message.data.currentY / 65535;
                        }

                        if (typeof message.data.currentSaturation !== 'undefined') {
                            device.meta.hue.state.sat = message.data.currentSaturation;
                        }

                        if (typeof message.data.colorMode !== 'undefined') {
                            switch (message.data.colorMode) {
                                case 0:
                                    device.meta.hue.state.colormode = 'hs';
                                    break;
                                case 1:
                                    device.meta.hue.state.colormode = 'xy';
                                    break;
                                case 2:
                                    device.meta.hue.state.colormode = 'ct';
                                    break;
                                default:
                            }
                        }
                    }

                    clearTimeout(publishTimeouts[device.ieeeAddr]);
                    publishTimeouts[device.ieeeAddr] = setTimeout(() => {
                        this.publishLightState(device);
                    }, 20);
                }
            };

            const offlineHandler = device => {
                if (device.meta.hue) {
                    this.lastState[device.ID] = oe.clone(device.meta.hue.state);
                    device.meta.hue.state.reachable = !device.meta.offline;
                    this.publishLightState(device);
                }
            };

            this.debug('adding event listeners');
            this.proxy.on('ready', readyHandler);
            this.proxy.on('devices', devicesHandler);
            this.proxy.on('message', messageHandler);
            this.proxy.on('offline', offlineHandler);
            this.proxy.on('nodeStatus', nodeStatusHandler);

            if (!this.gotDevices && shepherdNode.status === 'connected') {
                getDevices();
            }

            this.on('close', () => {
                this.debug('removing event listeners');
                this.proxy.removeListener('ready', readyHandler);
                this.proxy.removeListener('devices', devicesHandler);
                this.proxy.removeListener('message', messageHandler);
                this.proxy.removeListener('offline', offlineHandler);
                this.proxy.removeListener('nodeStatus', nodeStatusHandler);
                this.gotDevices = false;
            });

            this.on('input', (msg, send, done) => {
                if (!done) {
                    done = err => {
                        if (err) {
                            this.error(err.message);
                        }
                    };
                }

                let group;
                const type = 'lights';
                const device = this.searchDevice(this.config.device);
                if (!device) {
                    done(new Error('unknown light ' + this.config.device));
                    return;
                }

                let cmd = {};
                if (typeof msg.payload === 'string' && msg.payload.startsWith('{')) {
                    try {
                        msg.payload = JSON.parse(msg.payload);
                        cmd = msg.payload;
                    } catch (err) {
                        done(new Error('json parse failed ' + err.message + ' ' + msg.payload));
                        return;
                    }
                } else if (typeof msg.payload === 'object') {
                    cmd = msg.payload;
                } else if (typeof msg.payload === 'boolean') {
                    cmd.on = msg.payload;
                } else if (msg.payload === 'true') {
                    cmd.on = true;
                } else if (msg.payload === 'false') {
                    cmd.on = false;
                } else {
                    const bri = Number.parseInt(msg.payload, 10) || 0;
                    if (type === 'groups' || (bri > 0 && !device.meta.hue.type.startsWith('On/off'))) {
                        cmd.bri = bri;
                    }

                    cmd.on = bri > 0;
                }

                if (typeof cmd.transitiontime === 'undefined') {
                    //cmd.transitiontime = 4;
                }

                this.putLightsState({topic: type + '/' + (type === 'lights' ? device.ID : group.groupID) + '/state', payload: cmd}, send, done);
            });
        }

        searchDevice(search) {
            return this.devices && this.devices.find(device => {
                return device.meta.name === search ||
                    device.ieeeAddr === search ||
                    device.ID === Number.parseInt(search, 10);
            });
        }

        searchGroup(search) {
            return this.groups && this.groups.find(group => {
                return group.meta.name === search ||
                    group.groupID === Number.parseInt(search, 10);
            });
        }

        initLight(device) {
            const epFirst = device.endpoints[0];
            if (!epFirst) {
                this.debug(`initLight - endpoint missing?! ${device.ieeeAddr} ${device.meta.name}`);
                return;
            }

            const type = zllDevice[epFirst.deviceID];
            if (type && device.modelID !== 'lumi.router') {
                if (device.meta.hue) {
                    device.meta.hue.name = device.meta.name;
                } else {
                    this.debug(`initLight ${device.ieeeAddr} ${device.meta.name} ${device.modelID}`);
                    const uniqueid = device.ieeeAddr.replace('0x', '').replace(/([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})/, '$1:$2:$3:$4:$5:$6:$7:$8') + '-' + (uniqueidSuffix[device.manufacturerName] || '00');

                    device.meta.hue = {
                        state: emptyStates[type] || {on: false, reachable: false},
                        type,
                        name: device.meta.name,
                        modelid: device.modelID,
                        manufacturername: device.manufacturerName,
                        uniqueid,
                        swversion: device.softwareBuildID,
                        // Todo clarify: what is pointsymbol's purpose?
                        pointsymbol: {
                            1: 'none',
                            2: 'none',
                            3: 'none',
                            4: 'none',
                            5: 'none',
                            6: 'none',
                            7: 'none',
                            8: 'none'
                        }
                    };
                }

                device.save();
            }
        }

        putLightsState(msg, send, done) {
            if (!done) {
                done = err => {
                    if (err) {
                        this.error(err.message);
                    }
                };
            }
            // xy > ct > hs
            // on bool
            // bri uint8 0-254
            // bri uint8 1-254: // TODO some lights seem to not accept a 0 bri and return to 1?
            //      Osram Gardenpole RGBW-Lightify
            //
            //
            // hue uint16 0-65535
            // sat uint8 0-254
            // xy [float,float] 0-1
            // ct uint16 153-500
            // alert string "none", "select", "lselect"
            // effect string "none" "colorloop"
            // transitiontime uint16
            // bri_inc -254-254
            // sat_inc -254-254
            // hue_inc -65534-65534
            // ct_inc -65534-65534
            // xy_inc [] 0.5 0.5

            const [, type, index] = msg.topic.match(/([a-z]+)\/(\d+)\/state/);
            let group;
            let device;

            switch (type) {
                case 'lights':
                    device = this.searchDevice(index);
                    if (!device) {
                        done(new Error('unknown light ' + index));
                        return;
                    }

                    break;
                case 'groups':
                    group = this.searchGroup(index);
                    if (!group) {
                        done(new Error('unknown group ' + index));
                        return;
                    }

                    break;
                default:
                    done(new Error(`unknown type ${type}`));
                    return;
            }

            const cmds = [];

            if (msg.payload.on === false) {
                delete msg.payload.bri;
            }

            if (typeof msg.payload.on !== 'undefined' && typeof msg.payload.bri === 'undefined') {
                if (msg.payload.transitiontime) {
                    cmds.push({
                        cid: 'genLevelCtrl',
                        cmd: 'moveToLevelWithOnOff',
                        zclData: {
                            level: msg.payload.on ? 254 : 0,
                            transtime: msg.payload.transitiontime || 0
                        },
                        attributes: ['on', 'bri']

                    });
                } else {
                    cmds.push({
                        cid: 'genOnOff',
                        cmd: msg.payload.on ? 'on' : 'off',
                        zclData: {},
                        attributes: ['on']

                    });
                }
                //}
            }

            if (typeof msg.payload.bri !== 'undefined') {
                let level = msg.payload.bri;

                if (level > 254) {
                    level = 254;
                }

                cmds.push({
                    cid: 'genLevelCtrl',
                    // Todo: clarify - bri 1 sets off?
                    cmd: 'moveToLevelWithOnOff',
                    zclData: {
                        level,
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['on', 'bri']

                });
                //}
            } else if (typeof msg.payload.bri_inc !== 'undefined') {
                cmds.push({
                    cid: 'genLevelCtrl',
                    cmd: 'step',
                    zclData: {
                        // Todo clarify stepmode values expected by shepherd.
                        // Spec defines up=0x01 down=0x03, shepherd seems to use up=false down=true ?
                        stepmode: msg.payload.bri_inc < 0,
                        stepsize: Math.abs(msg.payload.bri_inc),
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['bri']

                });
            }

            if (typeof msg.payload.xy !== 'undefined') {
                cmds.push({
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColor',
                    zclData: {
                        colorx: Math.round(msg.payload.xy[0] * 65535),
                        colory: Math.round(msg.payload.xy[1] * 65535),
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['xy']

                });
            } else if (typeof msg.payload.xy_inc !== 'undefined') {
                cmds.push({

                    cid: 'lightingColorCtrl',
                    cmd: 'stepColor',
                    zclData: {
                        stepx: Math.round(msg.payload.xy_inc[0] * 65535),
                        stepy: Math.round(msg.payload.xy_inc[1] * 65535),
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['xy']
                });
            } else if (typeof msg.payload.ct !== 'undefined') {
                cmds.push({
                    cid: 'lightingColorCtrl',
                    cmd: 'moveToColorTemp',
                    zclData: {
                        colortemp: msg.payload.ct,
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['ct']
                });
            } else if (typeof msg.payload.ct_inc !== 'undefined') {
                // Todo - clarify: it seems there is no stepColorTemperature cmd - need to know the current ct value?
            } else if (typeof msg.payload.hue !== 'undefined' && typeof msg.payload.sat !== 'undefined') {
                cmds.push({
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHueAndSaturation',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        saturation: msg.payload.sat,
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['hue', 'sat']
                });
            } else if (typeof msg.payload.hue === 'undefined') {
                if (typeof msg.payload.sat !== 'undefined') {
                    cmds.push({
                        cid: 'lightingColorCtrl',
                        cmd: 'moveToSaturation',
                        zclData: {
                            saturation: msg.payload.sat,
                            transtime: msg.payload.transitiontime || 0
                        },
                        attributes: ['sat']
                    });
                } else if (typeof msg.payload.hue_inc !== 'undefined' && typeof msg.payload.sat_inc !== 'undefined') {
                    // TODO
                } else if (typeof msg.payload.hue_inc !== 'undefined') {
                    // TODO
                } else if (typeof msg.payload.sat_inc !== 'undefined') {
                    // TODO
                }
            } else {
                cmds.push({
                    cid: 'lightingColorCtrl',
                    cmd: 'enhancedMoveToHue',
                    zclData: {
                        enhancehue: msg.payload.hue,
                        direction: msg.payload.direction || 0,
                        transtime: msg.payload.transitiontime || 0
                    },
                    attributes: ['hue']
                });
            }

            if (typeof msg.payload.alert !== 'undefined') {
                let effectid;
                let val = msg.payload.alert;
                switch (val) {
                    case 'select':
                        effectid = 0;
                        break;
                    case 'lselect':
                        effectid = 1;
                        break;
                    default:
                        val = 'none';
                        effectid = 255;
                }

                cmds.push({
                    cid: 'genIdentify',
                    cmd: 'triggerEffect',
                    zclData: {
                        effectid,
                        effectvariant: 1
                    }
                });
            }

            if (typeof msg.payload.effect !== 'undefined') {
                // TODO
            }

            let update = false;
            let todo = cmds.length;

            switch (type) {
                case 'lights':
                    this.lastState[device.ID] = oe.clone(device.meta.hue.state);

                    this.debug(`putLightState ${device.ieeeAddr} ${device.meta.name} ${JSON.stringify(msg.payload)}`);

                    cmds.forEach(cmd => {
                        this.shepherdNode.command(device.ieeeAddr, device.endpoints[0].ID, cmd.cid, cmd.cmd, cmd.zclData, cmd.options)
                            .then(() => {
                                if (cmd.attributes) {
                                    const data = {};
                                    cmd.attributes.forEach(attr => {
                                        data[attr] = msg.payload[attr];
                                    });
                                    update = update || oe.extend(device.meta.hue.state, data);
                                }
                            }).catch(() => {}).finally(() => {
                                if (--todo === 0 && update) {
                                    this.publishLightState(device, send, done);
                                }
                            });
                    });
                    break;

                case 'groups':
                    this.debug(`putGroupState ${group.groupID} ${JSON.stringify(msg.payload)}`);
                    cmds.forEach(cmd => {
                        this.shepherdNode.groupCommand(group.groupID, cmd.cid, cmd.cmd, cmd.zclData, cmd.options)
                            .then(() => {
                                if (cmd.attributes) {
                                    const data = {};
                                    cmd.attributes.forEach(attr => {
                                        data[attr] = msg.payload[attr];
                                    });
                                    update = update || oe.extend(device.meta.hue.state, data);
                                }
                            }).catch(() => {}).finally(() => {
                                if (--todo === 0 && update) {
                                //this.publishLightState(device);
                                }
                            });
                    });
                    break;

                default:
            }
        }

        publishLightState(device, send, done) {
            send = send || this.send.bind(this);

            if (!done) {
                done = err => {
                    if (err) {
                        this.error(err.message);
                    }
                };
            }

            const topic = this.topicReplace(this.config.topic, {
                name: device.meta.name,
                ieeeAddr: device.ieeeAddr,
                index: device.ID
            });
            let change = false;
            const lightIndex = device.ID;

            if (!this.lastState[lightIndex]) {
                this.lastState[device.ID] = oe.clone(device.meta.hue.state);
            }

            const newState = device.meta.hue.state;

            if (this.lastState[lightIndex].reachable !== newState.reachable) {
                change = true;
                if (this.config.payload.includes('plain')) {
                    send({topic: topic + '/reachable', payload: newState.reachable, retain: true});
                }

                this.lastState[lightIndex].reachable = newState.reachable;
            }

            Object.keys(newState).forEach(attr => {
                if (attr === 'xy' && !this.lastState[lightIndex].xy) {
                    this.lastState[lightIndex].xy = [];
                }

                if (attr === 'xy' && !newState.xy) {
                    newState.xy = [];
                }

                if (
                    (attr !== 'xy' && (newState[attr] !== this.lastState[lightIndex][attr])) ||
                    (
                        attr === 'xy' && (
                            newState.xy[0] !== this.lastState[lightIndex].xy[0] ||
                            newState.xy[1] !== this.lastState[lightIndex].xy[1]
                        )
                    )
                ) {
                    change = true;
                    if (this.config.payload.includes('plain')) {
                        send({topic: topic + '/' + attr, payload: newState[attr], retain: true});
                    }

                    this.lastState[lightIndex][attr] = newState[attr];
                }
            });

            if (change && (this.config.payload.includes('mqttsh'))) {
                send({
                    topic,
                    payload: {
                        val: newState.on ? newState.bri : 0,
                        hue_state: newState /* eslint-disable-line camelcase */
                    },
                    name: device.meta.hue.name,
                    index: lightIndex,
                    ieeeAddr: device.ieeeAddr,
                    retain: true
                });
            } else if (change && (this.config.payload.includes('json'))) {
                send({
                    topic,
                    payload: newState,
                    name: device.meta.hue.name,
                    index: lightIndex,
                    ieeeAddr: device.ieeeAddr,
                    retain: true
                });
            }

            done();
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

    RED.nodes.registerType('zigbee-hue-device', ZigbeeHueDevice);
};
