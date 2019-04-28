# node-red-contrib-zigbee

[![NPM version](https://badge.fury.io/js/node-red-contrib-zigbee.svg)](http://badge.fury.io/js/node-red-contrib-zigbee)
[![Dependencies Status](https://david-dm.org/hobbyquaker/node-red-contrib-zigbee/status.svg)](https://david-dm.org/hobbyquaker/node-red-contrib-zigbee)
[![Build Status](https://travis-ci.org/hobbyquaker/node-red-contrib-zigbee.svg?branch=master)](https://travis-ci.org/hobbyquaker/node-red-contrib-zigbee)
[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)
[![License][mit-badge]][mit-url]

> Control Zigbee Devices (Xiaomi Aqara, Hue, Lightify, Tradfri, ...) with Node-RED via a CC253x Module. No need for
proprietary bridges anymore, use devices of different vendors in one Zigbee network.

**WORK IN PROGESS** - nevertheless I'm happy if you're willing to test it already, feedback of any kind is highly 
appreciated, just use the [issue tracker](https://github.com/hobbyquaker/node-red-contrib-zigbee/issues)- As soon as the
Todo list is worked off and it's considered as stable the version will be bumped to 1.0

## Credits

Based on [Koenkk's fork](https://github.com/Koenkk/zigbee-shepherd) of 
[Zigbee Shepherd](https://github.com/zigbeer/zigbee-shepherd). Strongly inspired by his awesome
[zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt) project. All credits belong to him and the creators of the 
zigbee-shepherd.


## Hardware Prerequisites

see https://www.zigbee2mqtt.io/getting_started/what_do_i_need.html
Ready to use firmware images are available here: https://github.com/Koenkk/Z-Stack-firmware/tree/master/coordinator

## Getting started

Add a "devices" Node, open it's configuration, add a "shepherd" node, configure it, close both nodes and deploy. Wait
a few seconds and go to the configuration of the "devices" node again, now you should be able to pair devices. Keep
an eye on Node-RED's log output.


## Nodes

#### shepherd

Config node that holds the serial port and ZigBee network configuration of zigbee-shepherd. You should change the 
precfgkey for security reasons before pairing the first devices. I suggest to use a password manager (like e.g. KeyPass) 
to create and store a random key (has to be 16 Byte in uppercase hex representation (32 chars 0-9A-F). 


#### devices

With this node devices can be paired, removed and named. If you send a numeric value to it's input it permits joining
of new devices for given seconds. If the value exceeds 254 it permits joining permanently. If it receives the value 0
joining is stopped. 


#### converter

This Node utilizes [Koenkk's zigbee-shepherd-converters](https://github.com/Koenkk/zigbee-shepherd-converters) and 
offers payload formats as known from zigbee2mqtt. In fact most of this nodes code is taken 1:1 from zigbee2mqtt.


#### hue api

This node mimics the Philips Hue bridge API for ZigBee Light Link devices.


#### hue light

This node aims to be a drop-in replacement for https://github.com/hobbyquaker/hue2mqtt.js


#### offline

This node outputs the online/offline status of the devices.


#### event

This Node outputs events as received from zigbee-shepherd. 


#### command

Send a "functional" or "foundation" command to a device endpoint. Payload has to be an object containing the properties 
`cmdType`, `ieeeAddress`, `ep`, `cId`, `cmd` and `zclData`. See 
https://github.com/zigbeer/zigbee-shepherd/wiki#API_functional



## License

MIT (c) Sebastian Raff

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
