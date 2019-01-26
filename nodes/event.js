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
                const event = message.type;

                let ieeeAddr;
                if (event === 'devIncoming' || event === 'devLeaving') {
                    ieeeAddr = message.data;
                } else {
                    ieeeAddr = message && message.endpoints && message.endpoints[0] && message.endpoints[0].device && message.endpoints[0].device.ieeeAddr;
                }

                if (ieeeAddr && config.events.includes(message.type)) {
                    if (!config.device || (ieeeAddr === config.device)) {
                        const out = {
                            topic: ieeeAddr + '/' + event,
                            payload: message.data,
                            event,
                            device: this.devices[ieeeAddr] || {}

                        };

                        this.send(out);
                    }
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-event', ZigbeeEvent);
};
