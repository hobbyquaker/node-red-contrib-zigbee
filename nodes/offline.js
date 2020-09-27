module.exports = function (RED) {
    class ZigbeeOffline {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            const nodeStatusHandler = status => {
                this.status(status);
            };

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.herdsman;
            this.topic = config.topic;

            const sendMessage = device => {
                if (config.device && (config.device !== device.ieeeAddr)) {
                    return;
                }

                if (typeof device.meta.offline !== 'boolean') {
                    return;
                }

                this.debug(`${device.ieeeAddr} ${device.meta.name} offline=${device.meta.offline}`);
                const msg = {
                    topic: null,
                    payload: device.meta.offline,
                    ieeeAddr: device.ieeeAddr,
                    name: device.meta.name,
                    lastSeen: device.lastSeen,
                    retain: true

                };
                msg.topic = this.topicReplace(this.topic, msg);
                this.send(msg);
            };

            const readyHandler = () => {
                this.trace('readyHandler');
                this.shepherdNode.herdsman.getDevices().forEach(sendMessage);
            };

            this.debug('adding event listeners');
            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('offline', sendMessage);
            shepherdNode.proxy.on('ready', readyHandler);

            this.on('close', () => {
                this.debug('removing event listeners');
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('offline', sendMessage);
                shepherdNode.proxy.removeListener('ready', readyHandler);
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

    RED.nodes.registerType('zigbee-offline', ZigbeeOffline);
};
