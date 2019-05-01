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
            this.devices = shepherdNode.devices;

            const nodeStatusHandler = status => {
                this.status(status);
            };

            const indHandler = message => {
                const event = message.type;

                let ieeeAddr;
                let cid;
                //let attribute;
                let epId;
                let devId;
                let profId;

                if (event === 'devIncoming' || event === 'devLeaving') {
                    ieeeAddr = message.data;
                } else {
                    // Todo clarify Endpoint. Is it always 1 per attReport?
                    const firstEp = (message && message.endpoints && message.endpoints[0]) || {};
                    epId = firstEp.epId;
                    devId = firstEp.devId;
                    profId = firstEp.profId;
                    ieeeAddr = firstEp.device && firstEp.device.ieeeAddr;
                    cid = message.data.cid;
                }

                if (ieeeAddr && (config.events.includes(message.type) || (config.events.includes('cmd') && event.startsWith('cmd')))) {
                    if (config.payload !== 'json' && message.data.data && Object.keys(message.data.data).length > 0) {
                        Object.keys(message.data.data).forEach(attribute => {
                            const topicAttrs = {
                                name: this.devices[ieeeAddr] && this.devices[ieeeAddr].name,
                                ieeeAddr,
                                event,
                                epId,
                                cid,
                                profId,
                                devId,
                                attribute,
                                linkquality: message.linkquality,
                                groupid: message.groupid
                            };

                            if (!config.device || (ieeeAddr === config.device)) {
                                const out = {
                                    topic: this.topicReplace(config.topic, topicAttrs),
                                    payload: message.data.data[attribute],
                                    event,
                                    groupid: message.groupid,
                                    device: this.devices[ieeeAddr] || {}
                                };

                                this.send(out);
                            }
                        });
                    } else {
                        const topicAttrs = {
                            name: this.devices[ieeeAddr] && this.devices[ieeeAddr].name,
                            ieeeAddr,
                            event,
                            epId,
                            cid,
                            profId,
                            devId,
                            linkquality: message.linkquality,
                            groupid: message.groupid
                        };

                        if (!config.device || (ieeeAddr === config.device)) {
                            const out = {
                                topic: this.topicReplace(config.topic, topicAttrs),
                                payload: (message.data && message.data.data) || message.data,
                                event,
                                groupid: message.groupid,
                                device: this.devices[ieeeAddr] || {}

                            };

                            this.send(out);
                        }
                    }
                }
            };

            shepherdNode.proxy.on('nodeStatus', nodeStatusHandler);
            shepherdNode.proxy.on('ind', indHandler);

            this.on('close', () => {
                shepherdNode.proxy.removeListener('nodeStatus', nodeStatusHandler);
                shepherdNode.proxy.removeListener('ind', indHandler);
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

    RED.nodes.registerType('zigbee-event', ZigbeeEvent);
};
