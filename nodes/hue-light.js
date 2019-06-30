module.exports = function (RED) {
    class ZigbeeHueLight {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherdNode = shepherdNode;
            this.devices = shepherdNode.devices;
            this.shepherd = shepherdNode.shepherd;
            this.proxy = shepherdNode.proxy;

            shepherdNode.proxy.on('nodeStatus', status => {
                this.status(status);
            });

            const lastState = {};

            const updateLightHandler = lightIndex => {
                const topic = this.topicReplace(config.topic, {
                    name: shepherdNode.lights[lightIndex].name,
                    ieeeAddr: shepherdNode.lightsInternal[lightIndex].ieeeAddr,
                    index: lightIndex
                });

                let change = false;

                if (!lastState[lightIndex]) {
                    lastState[lightIndex] = {xy: []};
                }

                const newState = shepherdNode.lights[lightIndex].state;

                if (typeof newState.bri === 'undefined') {
                    newState.bri = 254;
                }
                if (typeof newState.on === 'undefined') {
                    newState.on = false;
                }

                if (lastState[lightIndex].reachable !== newState.reachable) {
                    change = true;
                    if (config.payload !== 'json') {
                        this.send({topic: topic + '/reachable', payload: newState.reachable, retain: true});
                    }

                    lastState[lightIndex].reachable = newState.reachable;
                }

                Object.keys(newState).forEach(attr => {
                    if (
                        (attr !== 'xy' && (newState[attr] !== lastState[lightIndex][attr])) ||
                        (
                            attr === 'xy' && (
                                newState.xy[0] !== lastState[lightIndex].xy[0] ||
                                newState.xy[1] !== lastState[lightIndex].xy[1]
                            )
                        )
                    ) {
                        change = true;
                        if (config.payload !== 'json') {
                            this.send({topic: topic + '/' + attr, payload: newState[attr], retain: true});
                        }

                        lastState[lightIndex][attr] = newState[attr];
                    }
                });

                if (change && (config.payload !== 'plain')) {
                    this.send({
                        topic,
                        payload: {
                            val: (newState.on || newState.bri > 1) ? newState.bri : 0,
                            hue_state: newState /* eslint-disable-line camelcase */
                        },
                        name: shepherdNode.lights[lightIndex].name,
                        index: lightIndex,
                        ieeeAddr: shepherdNode.lightsInternal[lightIndex].ieeeAddr,
                        retain: true
                    });
                }
            };

            this.proxy.on('updateLight', updateLightHandler);
            this.proxy.on('updateLightState', updateLightHandler);

            this.on('close', () => {
                this.proxy.removeListener('updateLight', updateLightHandler);
                this.proxy.removeListener('updateLightState', updateLightHandler);
            });

            this.on('input', msg => {
                const topic = (msg.topic || '').split('/');
                const settopic = config.settopic.split('/');
                const topicAttrs = {};
                for (let i = 0; i < topic.length; i++) {
                    const match = settopic[i].match(/\${([^}]+)}/);
                    if (match) {
                        topicAttrs[match[1]] = topic[i];
                    } else if (topic[i] !== settopic[i]) {
                        this.debug('topic mismatch ' + msg.topic + ' ' + config.settopic);
                        return;
                    }
                }

                const search = topicAttrs.name || topicAttrs.index || topicAttrs.ieeeAddr;

                const index = shepherdNode.getLightIndex(search);

                if (!index) {
                    this.warn('unknown light ' + JSON.stringify(topicAttrs));
                    return;
                }

                let cmd = {};
                if (topicAttrs.attribute) {
                    if (msg.payload === 'false') {
                        msg.payload = false;
                    } else if (msg.payload === 'true') {
                        msg.payload = true;
                    } else if (!isNaN(msg.payload)) {
                        msg.payload = Number(msg.payload);
                    }

                    cmd[topicAttrs.attribute] = msg.payload;
                } else if (typeof msg.payload === 'string' && msg.payload.startsWith('{')) {
                    try {
                        msg.payload = JSON.parse(msg.payload);
                        cmd = msg.payload;
                    } catch (err) {
                        this.error('json parse failed ' + err.message + ' ' + msg.payload);
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
                    const bri = parseInt(msg.payload, 10) || 0;
                    if (!shepherdNode.lightsInternal[index].type.startsWith('On/off')) {
                        cmd.bri = bri;
                    }

                    if (bri) {
                        cmd.on = true;
                    } else {
                        cmd.on = false;
                    }
                }

                if (typeof cmd.transitiontime === 'undefined') {
                    //cmd.transitiontime = 4;
                }

                shepherdNode.putLightsState({topic: 'lights/' + index + '/state', payload: cmd});
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

    RED.nodes.registerType('zigbee-hue-light', ZigbeeHueLight);
};
