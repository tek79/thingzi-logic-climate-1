module.exports = function(RED) {
  'use strict';
  const moment = require('moment');
  const mqtt = require('./mqtt');

  const offValue = 'off';
  const noneValue = 'none';
  const boostValue = 'boost';
  const awayValue = 'away';

  RED.nodes.registerType('thingzi-climate', function(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    // Internal State
    this.name = config.name || this.id;
    this.sendTopic = config.name
      ? `${config.name.toLowerCase().trim().replace(/\s+/g, '-')}`
      : `${this.id}`;
    this.deviceId = config.name
      ? `${config.name.toLowerCase().trim().replace(/\s+/g, '-')}-climate`
      : `${this.id}-climate`;
    this.sendStatus = config.sendStatus;
    this.outputs = config.outputs;
    this.updateTimeout = null;
    this.starting = true;

    // Configuration
    this.keepAliveMs = parseFloat(config.keepAlive) * 1000 * 60; //< mins to ms
    this.cycleDelayMs = parseFloat(config.cycleDelay) * 1000; //< seconds to ms
    this.boostDurationMins = config.boostDuration;

    // Set Point
    this.degrees = config.degrees;
    this.defaultHeatSetpoint = parseFloat(config.defaultHeatSetpoint);
    this.defaultCoolSetpoint = parseFloat(config.defaultCoolSetpoint);
    this.tolerance = parseFloat(config.tolerance);
    this.minTemp = parseFloat(config.minTemp);
    this.maxTemp = parseFloat(config.maxTemp);
    this.tempValidMs = parseFloat(config.tempValid) * 1000 * 60; //< mins to ms
    this.swapDelayMs = parseFloat(config.swapDelay) * 1000 * 60; //< mins to ms

    // Outputs
    this.onPayload = config.onPayload;
    this.onPayloadType = config.onPayloadType;
    this.offPayload = config.offPayload;
    this.offPayloadType = config.offPayloadType;

    // Advertising
    this.advertise = config.advertise;
    this.broker = RED.nodes.getNode(config.broker);
    this.topic = config.topic
      ? `${config.topic.toLowerCase().trim('/')}/${this.deviceId}`
      : null;

    // Capabilities
    this.hasHeating =
      config.climateType === 'both' ||
      config.climateType === 'heat' ||
      config.climateType === 'manual';
    this.hasCooling =
      config.climateType === 'both' ||
      config.climateType === 'cool' ||
      config.climateType === 'manual';
    this.hasSetpoint = config.climateType !== 'manual';

    // Default mode when on value or boost is used
    this.defaultMode = 'heat';
    if (config.climateType === 'both') {
      this.defaultMode = 'auto';
    } else if (config.climateType === 'cool') {
      this.defaultMode = 'cool';
    }

    // Previous state
    this.lastChange = null;
    this.lastAction = null;
    this.lastTemp = null;
    this.lastHeatTime = null;
    this.lastCoolTime = null;
    this.lastSend = null;

    // Handle direct inputs
    this.on('input', function(msg, send, done) {
      if (msg.hasOwnProperty('payload')) {
        node.mode.set(msg.payload);
      }
      if (msg.hasOwnProperty('mode')) {
        node.mode.set(msg.mode);
      }
      if (msg.hasOwnProperty('temperature')) {
        node.setpoint.set(msg.temperature);
      }
      if (msg.hasOwnProperty('setpoint')) {
        node.setpoint.set(msg.setpoint);
      }
      if (msg.hasOwnProperty('override')) {
        node.override.set(msg.override);
      }
      if (msg.hasOwnProperty('action')) {
        node.action.set(msg.action);
      }
      if (done) {
        done();
      }
    });

    // Handle MQTT inputs
    this.on('mqttIn', function(topic, payload) {
      if (topic.endsWith('/mode/set')) {
        node.mode.set(payload);
      }
      if (topic.endsWith('/temperature/set')) {
        node.setpoint.set(payload);
      }
    });

    // Update node status
    this.updateStatus = function() {
      let status = {};
      status.fill = 'blue';
      status.shape = 'dot';
      status.text = 'disconnected';
      if (node.isConnected()) {
        status.text = 'connected';
      }
      if (node.lastChange) {
        status.shape = 'ring';
        status.fill = node.isHeating()
          ? 'red'
          : node.isCooling()
          ? 'blue'
          : 'green';
        status.text = node.lastChange;
      }
      node.status(status);
    };

    // Is the device currently connected?
    this.isConnected = function() {
      return moment().diff(node.lastSend || 0) < node.keepAliveMs;
    };

    // Is the device currently heating?
    this.isHeating = function() {
      return node.lastAction === 'heating';
    };

    // Is the device currently cooling?
    this.isCooling = function() {
      return node.lastAction === 'cooling';
    };

    // Calculate the setpoint action based on the current temperature and setpoint
    this.calculateAction = function(currentTemp, targetTemp) {
      const heatSetpoint = parseFloat(node.getHeatSetpoint());
      const coolSetpoint = parseFloat(node.getCoolSetpoint());

      if (currentTemp < targetTemp - node.tolerance) {
        if (heatSetpoint !== null && currentTemp < heatSetpoint - node.tolerance) {
          return 'heating';
        }
      } else if (currentTemp > targetTemp + node.tolerance) {
        if (coolSetpoint !== null && currentTemp > coolSetpoint + node.tolerance) {
          return 'cooling';
        }
      }

      return 'none';
    };

    // Get the current heat setpoint
    this.getHeatSetpoint = function() {
      return node.getStoredValue('heatSetpoint', node.defaultHeatSetpoint);
    };

    // Set the current heat setpoint
    this.setHeatSetpoint = function(setpoint) {
      node.setStoredValue('heatSetpoint', setpoint);
    };

    // Get the current cool setpoint
    this.getCoolSetpoint = function() {
      return node.getStoredValue('coolSetpoint', node.defaultCoolSetpoint);
    };

    // Set the current cool setpoint
    this.setCoolSetpoint = function(setpoint) {
      node.setStoredValue('coolSetpoint', setpoint);
    };

    // Get a value from the context storage
    this.getStoredValue = function(key, defaultValue) {
      const storedValue = node.context().get(key);
      return storedValue !== undefined ? storedValue : defaultValue;
    };

    // Set a value in the context storage
    this.setStoredValue = function(key, value) {
      node.context().set(key, value);
    };

    // Update the node status and trigger an update message
    this.updateNode = function() {
      node.updateStatus();
      const msg = {
        topic: node.topic,
        payload: {
          deviceId: node.deviceId,
          name: node.name,
          mode: node.lastChange || noneValue,
          temperature: node.lastTemp || noneValue,
          action: node.lastAction || noneValue,
          heatSetpoint: node.getHeatSetpoint(),
          coolSetpoint: node.getCoolSetpoint(),
          connected: node.isConnected(),
        },
      };
      node.send([null, msg]);
    };

    // Update the stored temperature if the current one is valid
    this.updateTemperature = function(temp) {
      const now = moment();
      if (
        temp !== null &&
        temp >= node.minTemp &&
        temp <= node.maxTemp &&
        (node.lastTemp === null ||
          Math.abs(temp - node.lastTemp) <= node.tolerance ||
          now.diff(node.lastTempTime || 0) > node.swapDelayMs)
      ) {
        node.lastTemp = temp;
        node.lastTempTime = now;
      }
    };

    // Update the setpoint action based on the current temperature
    this.updateAction = function() {
      if (node.lastTemp === null) {
        node.lastAction = noneValue;
        return;
      }
      const targetTemp = parseFloat(node.setpoint.get());
      node.lastAction = node.calculateAction(node.lastTemp, targetTemp);
    };

    // Send the current status to the device
    this.sendStatusUpdate = function() {
      if (!node.advertise || !node.broker || !node.topic) {
        return;
      }
      const msg = {
        topic: `${node.topic}/status`,
        payload: {
          name: node.name,
          mode: node.lastChange || noneValue,
          temperature: node.lastTemp || noneValue,
          action: node.lastAction || noneValue,
          heatSetpoint: node.getHeatSetpoint(),
          coolSetpoint: node.getCoolSetpoint(),
          connected: node.isConnected(),
        },
      };
      node.broker.publish(msg);
      node.lastSend = moment();
    };

    // Set the setpoint and update the action
    this.setSetpoint = function(setpoint) {
      node.setpoint.set(setpoint);
      node.updateAction();
    };

    // Handle the mode change
    this.handleModeChange = function(newMode) {
      node.lastChange = newMode;
      node.lastHeatTime = null;
      node.lastCoolTime = null;

      if (newMode === 'off') {
        node.lastAction = 'none';
        node.setpoint.set(null);
        node.override.set(false);
        node.updateNode();
        return;
      }

      if (node.defaultMode === 'auto') {
        if (newMode === 'heat') {
          node.setpoint.set(node.getHeatSetpoint());
        } else if (newMode === 'cool') {
          node.setpoint.set(node.getCoolSetpoint());
        }
      }

      node.updateAction();
      node.updateNode();
    };

    // Initialize the setpoint
    this.initSetpoint = function() {
      if (!node.hasSetpoint) {
        return;
      }
      const defaultSetpoint = node.defaultMode === 'heat' ? node.getHeatSetpoint() : node.getCoolSetpoint();
      node.setpoint = {
        set: function(setpoint) {
          if (node.hasSetpoint && setpoint !== null) {
            const newSetpoint = parseFloat(setpoint);
            if (!isNaN(newSetpoint) && newSetpoint >= node.minTemp && newSetpoint <= node.maxTemp) {
              this.current = newSetpoint;
              this.lastChange = moment();
            }
          }
        },
        get: function() {
          if (node.hasSetpoint && this.lastChange && moment().diff(this.lastChange) <= node.tempValidMs) {
            return this.current;
          }
          return defaultSetpoint;
        },
      };
    };

    // Initialize the override state
    this.initOverride = function() {
      node.override = {
        set: function(state) {
          this.current = state === true;
        },
        get: function() {
          return this.current === true;
        },
      };
    };

    // Initialize the action state
    this.initAction = function() {
      node.action = {
        set: function(action) {
          if (action === 'heating' && node.hasHeating) {
            node.handleModeChange('heat');
          } else if (action === 'cooling' && node.hasCooling) {
            node.handleModeChange('cool');
          } else if (action === 'none') {
            node.handleModeChange('auto');
          }
        },
        get: function() {
          if (node.lastAction === 'heating' && node.hasHeating) {
            return 'heating';
          } else if (node.lastAction === 'cooling' && node.hasCooling) {
            return 'cooling';
          }
          return 'none';
        },
      };
    };

    // Initialize the mode state
    this.initMode = function() {
      node.mode = {
        set: function(mode) {
          if (mode === 'off') {
            node.handleModeChange('off');
          } else if (mode === 'heat' && node.hasHeating) {
            node.handleModeChange('heat');
          } else if (mode === 'cool' && node.hasCooling) {
            node.handleModeChange('cool');
          } else {
            node.handleModeChange('auto');
          }
        },
        get: function() {
          return node.lastChange || node.defaultMode;
        },
      };
    };

    // Initialize the MQTT client
    this.initMqttClient = function() {
      if (node.advertise && node.broker && node.topic) {
        const mqttConfig = {
          clientId: `${node.deviceId}-mqtt`,
          keepalive: 60,
          clean: false,
          reconnectPeriod: 5000,
          username: node.broker.credentials.username,
          password: node.broker.credentials.password,
        };

        node.client = mqtt.connect(node.broker.brokerurl, mqttConfig);

        node.client.on('connect', function() {
          node.client.subscribe(`${node.topic}/#`, function(err, granted) {
            if (err) {
              node.warn('MQTT subscription failed: ' + err);
            } else {
              node.log('MQTT subscribed to topics: ' + JSON.stringify(granted));
            }
            node.updateStatus();
          });
        });

        node.client.on('message', function(topic, payload) {
          node.emit('mqttIn', topic, payload.toString());
        });

        node.client.on('close', function() {
          node.updateStatus();
        });

        node.client.on('error', function(err) {
          node.warn('MQTT error: ' + err);
        });
      }
    };

    // Initialize the update loop
    this.initUpdateLoop = function() {
      setInterval(function() {
        if (node.starting || !node.isConnected()) {
          node.updateStatus();
          return;
        }

        node.updateAction();
        node.updateTemperature(parseFloat(node.lastTemp));

        if (node.isHeating()) {
          node.lastHeatTime = moment();
        } else if (node.isCooling()) {
          node.lastCoolTime = moment();
        }

        const now = moment();
        if (node.isHeating() && node.lastHeatTime && now.diff(node.lastHeatTime) >= node.boostDurationMins * 60 * 1000) {
          node.lastAction = 'none';
        } else if (node.isCooling() && node.lastCoolTime && now.diff(node.lastCoolTime) >= node.boostDurationMins * 60 * 1000) {
          node.lastAction = 'none';
        }

        node.updateNode();
        node.sendStatusUpdate();
        node.updateStatus();
      }, node.cycleDelayMs);
    };

    // Initialize the node
    this.init = function() {
      node.initSetpoint();
      node.initOverride();
      node.initAction();
      node.initMode();
      node.initMqttClient();
      node.initUpdateLoop();
      node.starting = false;
    };

    // Initialize the node
    node.init();
  });
};
