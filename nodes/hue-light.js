const oe = require('obj-ease');

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

            let nodeStatus;
            shepherdNode.proxy.on('nodeStatus', status => {
                nodeStatus = status;
                this.status(status);
            });

            const lastState = {};

            const updateLightHandler = lightIndex => {
                //console.log('updateLightHandler', lightIndex, shepherdNode.lights[lightIndex]);

                const topic = this.topicReplace(config.topic, {
                    name: shepherdNode.lights[lightIndex].name,
                    ieeeAddr: shepherdNode.lightsInternal[lightIndex].ieeeAddr,
                    index: lightIndex
                });

                let change = false;

                if (!lastState[lightIndex]) {
                    lastState[lightIndex] = {xy: []};
                }

                if (lastState[lightIndex].reachable !== shepherdNode.lights[lightIndex].state.reachable) {
                    change = true;
                    if (config.payload !== 'json') {
                        this.send({topic: topic + '/reachable', payload: shepherdNode.lights[lightIndex].state.reachable, retain: true});
                    }

                    lastState[lightIndex].reachable = shepherdNode.lights[lightIndex].state.reachable;
                }

                Object.keys(shepherdNode.lights[lightIndex].state).forEach(attr => {
                    if (
                        (attr !== 'xy' && (shepherdNode.lights[lightIndex].state[attr] !== lastState[lightIndex][attr])) ||
                        (
                            attr === 'xy' && (
                                shepherdNode.lights[lightIndex].state.xy[0] !== lastState[lightIndex].xy[0] ||
                                shepherdNode.lights[lightIndex].state.xy[1] !== lastState[lightIndex].xy[1]
                            )
                        )
                    ) {
                        change = true;
                        if (config.payload !== 'json') {
                            this.send({topic: topic + '/' + attr, payload: shepherdNode.lights[lightIndex].state[attr], retain: true});
                        }

                        lastState[lightIndex][attr] = shepherdNode.lights[lightIndex].state[attr];
                    }
                });

                if (change && (config.payload !== 'plain')) {
                    this.send({
                        topic,
                        payload: {
                            val: shepherdNode.lights[lightIndex].state.on ? shepherdNode.lights[lightIndex].state.bri : 0,
                            hue_state: shepherdNode.lights[lightIndex].state
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
                console.log('input!');
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
