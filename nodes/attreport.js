module.exports = function (RED) {
    class ZigbeeAttReport {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherd = shepherdNode.shepherd;

            this.shepherd.on('ind', msg => {
                const device = msg.endpoints[0].device;
                if (msg.type === 'attReport') {
                    const out = {
                        topic: device.ieeeAddr,
                        type: device.type,
                        manufName: device.manufName,
                        modelId: device.modelId,
                        cid: msg.data.cid,
                        data: msg.data.data
                    };

                    this.send(out);
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-attreport', ZigbeeAttReport);
};
