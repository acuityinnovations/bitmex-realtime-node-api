'use strict';
const WebSocket = require('ws');
const debug = require('debug')('BitMEX:realtime-api:socket:internal');

const CLOSE_NORMAL = 1000;
const CLOSE_UNEXPECTED = 1011;
const CLOSE_DOWNTIME = 1012;
const CONNECTION_BUFFER = 10;
const CONNECTION_REFILL_TIME = 90;
const PING_INTERVAL = 60000

function WebSocketClient({logger}){
  this.initialAutoReconnectInterval = 1000;    // ms
  this.autoReconnectInterval = this.initialAutoReconnectInterval;
  this.maxAutoReconnectInterval = 60000; // maximum wait between reconnect retrys
  this.logConnection = true;
  this.remaining = 40;
  this.logger = logger;
}
WebSocketClient.prototype.open = function(url){
  this.url = url;
  this.instance = new WebSocket(this.url);
  this.instance.on('open', () => {
    this.autoReconnectInterval = this.initialAutoReconnectInterval; // reset delay
    this.log(this.log);
    this.onopen();
    manualClose(this.instance);
    pingIt(this.instance);
  });
  this.instance.on('message', (data, flags) => {
    this.onmessage(data,flags);
  });
  this.instance.on('pong', () => { pingIt(this.instance) });
  this.instance.on('close', (code) => {
    let reconnecting = false;

    switch (code){
      case CLOSE_NORMAL:
        debug(`WebSocket closed normally.`);
        break;
      case CLOSE_UNEXPECTED:
        this.logError("WebSocket closed unexpectedly.");
        break;
      default:    // Abnormal closure
        this.logError(`WebSocket closed with code ${code}`);
        reconnecting = true;
        break;
    }
    this.onclose(code);
    if (reconnecting) {
      this.reconnect(code);
    } else {
      this.onend(code);
    }
  });
  this.instance.on('error', (e) => {
    if (e.code) {
      this.logError("Error on connection.", e.message);
    }
    switch (e.code){
      case 'ECONNREFUSED':
        break;
      default:
        this.onerror(e);
        break;
    }
  });
  this.instance.on('unexpected-response', (request, response) => {
    // Parse body
    let buf = '';
    response.on('data', (data) => { buf += data; });
    response.on('end', () => {

      let closeConnection = code => {
        if (code === CLOSE_UNEXPECTED)
          this.log('The WebSocket will terminate. Please manually reconnect.');
        request.abort();
        this.instance.close(code);
        this.instance.emit('close', code);
      };

      if (response.statusCode === 401) {
        this.logError(`Authentication invalid. Please check your credentials. Message: ${buf}`);
        closeConnection(CLOSE_UNEXPECTED);
      } else if (response.statusCode === 502 || response.statusCode === 503) {
        // maintainence / downtime
        this.logError(`Server responded with [${response.statusCode}], will retry soon: ${buf}`);
        this.autoReconnectInterval = 5000; // first retry in 5 seconds
        closeConnection(CLOSE_DOWNTIME);
      } else {
        this.logError(`Unexpected response from server [${response.statusCode}]: ${buf}`);
        closeConnection(CLOSE_UNEXPECTED);
      }
    })

  })
};

// Forward eventemitter methods
['on', 'off', 'once', 'addListener', 'removeListener', 'emit'].forEach(function(key) {
  WebSocketClient.prototype[key] = function() {
    this.instance[key].apply(this.instance, arguments);
  };
});

WebSocketClient.prototype.log = function() {
  if (!this.logConnection) return;
  const args = [].slice.call(arguments);
  console.log.apply(console, ['WebSocket [INFO]:'].concat(args));
}

WebSocketClient.prototype.logError = function() {
  const args = [].slice.call(arguments);
  console.error.apply(console, ['WebSocket [ERROR]:'].concat(args));
}

WebSocketClient.prototype.send = function(data, option) {
  try{
    debug(data);
    this.instance.send(data, option);
  } catch (e){
    this.instance.emit('error',e);
  }
};
WebSocketClient.prototype.reconnect = function(_code) {
  this.logger.info(`connection rem: ${this.remaining}`)
  let availableConn = this.remaining - CONNECTION_BUFFER;
  clearTimeout(this.reconnectTimeout);
  if(availableConn > 0) {
    this.logger.info(`Retry in ${this.autoReconnectInterval} ms`)
    this.reconnectTimeout = setTimeout(() => {
      this.emit('reconnect');
      // increase wait for next time to avoid spamming the server
      if (this.autoReconnectInterval < this.maxAutoReconnectInterval) {
        this.autoReconnectInterval *= 2;
        if (this.autoReconnectInterval > this.maxAutoReconnectInterval)
          this.autoReconnectInterval = this.maxAutoReconnectInterval;
      }
      this.instance.close(CLOSE_NORMAL, 'Reconnecting.');
      this.log("Reconnecting...");
      this.open(this.url);
    }, this.autoReconnectInterval);
  } else {
    let timeToWait = Math.abs(availableConn) * CONNECTION_REFILL_TIME * 1000
    this.logger.info(`Retry in ${timeToWait} ms`)
    this.reconnectTimeout = setTimeout(() => {
      this.emit('reconnect');
      this.instance.close(CLOSE_NORMAL, 'Reconnecting.');
      this.log("Reconnecting...");
      this.open(this.url);
    }, timeToWait);
  }
};

function pingIt(client) {
  clearTimeout(client.pingTimeout);
  client.pingTimeout = setTimeout(() => {
    client.ping();
  }, PING_INTERVAL);
}

module.exports = WebSocketClient;
