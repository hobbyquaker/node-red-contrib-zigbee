module.exports = function (RED) {
    class ZigbeeBind {
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

            });
        }
    }

    RED.nodes.registerType('zigbee-bind', ZigbeeBind);
};
