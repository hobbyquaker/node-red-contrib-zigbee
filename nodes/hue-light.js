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
                
                const newState = shepherdNode.lights[lightIndex].state;

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
                            val: newState.on ? newState.bri : 0,
                            hue_state: newState
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
