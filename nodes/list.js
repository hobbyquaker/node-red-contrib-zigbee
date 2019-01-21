module.exports = function (RED) {
    class ZigbeeList {
        constructor(config) {
            RED.nodes.createNode(this, config);

            const shepherdNode = RED.nodes.getNode(config.shepherd);

            if (!shepherdNode) {
                this.error('missing shepherd');
                return;
            }

            this.shepherd = shepherdNode.shepherd;

            this.on('input', msg => {
                const list = this.shepherd.list();
                msg.payload = list;
                this.send(msg);
            });
        }
    }

    RED.nodes.registerType('zigbee-list', ZigbeeList);
};
