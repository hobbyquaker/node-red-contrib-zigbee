module.exports = function (RED) {
    class ZigbeeEvent {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            shepherdNode.proxy.on('nodeStatus', status => this.status(status));

            this.shepherd = shepherdNode.proxy;
            this.devices = shepherdNode.devices;

            this.shepherd.on('ind', message => {
                console.log(message);
                const event = message.type;

                let ieeeAddr;
                let cid;
                let attribute;
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

                if (config.payload !== 'json' && message.data.data) {
                    Object.keys(message.data.data).forEach(attribute => {
                        const topicAttrs = {
                            name: this.devices[ieeeAddr] && this.devices[ieeeAddr].name,
                            ieeeAddr,
                            epId,
                            cid,
                            profId,
                            devId,
                            attribute,
                            linkquality: message.linkquality,
                            groupid: message.groupid
                        };

                        if (ieeeAddr && config.events.includes(message.type)) {
                            if (!config.device || (ieeeAddr === config.device)) {
                                const out = {
                                    topic: this.topicReplace(config.topic, topicAttrs),
                                    payload: message.data.data[attribute],
                                    event,
                                    device: this.devices[ieeeAddr] || {}
                                };

                                this.send(out);
                            }
                        }
                    });
                } else {
                    const topicAttrs = {
                        name: this.devices[ieeeAddr] && this.devices[ieeeAddr].name,
                        ieeeAddr,
                        epId,
                        cid,
                        profId,
                        devId,
                        linkquality: message.linkquality,
                        groupid: message.groupid
                    };

                    if (ieeeAddr && config.events.includes(message.type)) {
                        if (!config.device || (ieeeAddr === config.device)) {
                            const out = {
                                topic: this.topicReplace(config.topic, topicAttrs),
                                payload: (message.data && message.data.data) || message.data,
                                event,
                                device: this.devices[ieeeAddr] || {}

                            };

                            this.send(out);
                        }
                    }
                }
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
