function endpointToJson(endpoint) {
    return {
        ID: endpoint.ID,
        clusters: endpoint.clusters,
        endpointID: endpoint.endpointID,
        deviceNetworkAddress: endpoint.deviceNetworkAddress,
        deviceIeeeAddr: endpoint.getDevice().ieeeAddr,
        inputClusters: endpoint.inputClusters,
        outputClusters: endpoint.outputClusters,
        profileID: endpoint.profileID,
        deviceID: endpoint.deviceID,
        binds: endpoint.binds
    };
}

function deviceToJson(device) {
    return {
        ieeeAddr: device.ieeeAddr,
        applicationVersion: device.applicationVersion,
        dateCode: device.dateCode,
        endpoints: device.endpoints.map(endpoint => endpointToJson(endpoint)),
        hardwareVersion: device.hardwareVersion,
        interviewCompleted: device.interviewCompleted,
        interviewing: device.interviewing,
        lastSeen: device.lastSeen,
        manufacturerID: device.manufacturerID,
        manufacturerName: device.manufacturerName,
        modelID: device.modelID,
        networkAddress: device.networkAddress,
        powerSource: device.powerSource,
        softwareBuildID: device.softwareBuildID,
        stackVersion: device.stackVersion,
        type: device.type,
        zclVersion: device.zclVersion,
        meta: device.meta
    };
}

function groupToJson(group) {
    return {
        groupID: group.groupID,
        members: group.members.map(endpoint => endpointToJson(endpoint)),
        meta: group.meta
    };
}

module.exports = {
    deviceToJson,
    groupToJson
};

