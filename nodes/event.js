module.exports = function (RED) {
    class ZigbeeEvent {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherd = shepherdNode.proxy;

            const nodeStatusHandler = status => {
                this.status(status);
            };

            const messageHandler = message => {
                if ((config.events.includes(message.type) || (config.events.includes('command') && message.type.startsWith('command')))) {
                    const {device} = message;

                    if (config.device && (device.ieeeAddr !== config.device)) {
                        return;
                    }

                    const topicAttrs = {
                        name: device.meta.name,
                        ieeeAddr: device.ieeeAddr,
                        type: message.type,
                        endpoint: message.endpoint.ID,
                        cluster: message.cluster,
                        profileID: message.endpoint.profileID,
                        groupID: message.groupID
                    };

                    if (config.payload === 'json') {
                        this.send({
                            topic: this.topicReplace(config.topic, topicAttrs),
                            payload: message.data,
                            type: message.type,
                            ieeeAddr: device.ieeeAddr,
                            name: device.meta.name,
                            endpoint: message.endpoint.ID,
                            cluster: message.cluster,
                            data: message.data,
                            linkquality: message.linkquality,
                            groupid: message.groupid

                        });
                    } else {
                        Object.keys(message.data).forEach(attribute => {
                            topicAttrs.attribute = attribute;
                            this.send({
                                topic: this.topicReplace(config.topic, topicAttrs),
                                payload: message.data[attribute],
                                type: message.type,
                                ieeeAddr: device.ieeeAddr,
                                name: device.meta.name,
                                endpoint: message.endpoint.ID,
                                cluster: message.cluster,
                                data: message.data,
                                linkquality: message.linkquality,
                                groupid: message.groupid
                            });
                        });
                    }
                }
            };

            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('message', messageHandler);

            this.on('close', () => {
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('message', messageHandler);
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

            return topic.replace(/\/$/, '');
        }
    }

    RED.nodes.registerType('zigbee-event', ZigbeeEvent);
};
