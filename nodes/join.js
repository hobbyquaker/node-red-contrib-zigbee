module.exports = function (RED) {
    class ZigbeeJoin {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherd = shepherdNode.shepherd;

            this.on('input', msg => {
                let time = parseInt(msg.payload, 10) || 30;
                time = time > 255 ? 255 : time;
                this.shepherd.permitJoin(time);

            });

            this.shepherd.on('permitJoining', joinTimeLeft => {
                this.send({payload: joinTimeLeft});
                if (joinTimeLeft) {
                    this.status({fill: 'blue', shape: 'ring', text: joinTimeLeft + 's'});
                } else {
                    this.status({});
                }
            });
        }
    }

    RED.nodes.registerType('zigbee-join', ZigbeeJoin);
};
