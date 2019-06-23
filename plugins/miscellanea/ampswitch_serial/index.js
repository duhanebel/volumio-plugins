'use strict';

// load external modules
var libQ = require('kew');
var io = require('socket.io-client');
var SerialPort = require('serialport');

var socket = io.connect('http://localhost:3000');

//declare global status variable
var status_amp = 'na';

// Define the SerialSwitchController class
module.exports = SerialSwitchController;

function SerialSwitchController(context) {
	var self = this; 

	// Save a reference to the parent commandRouter
	self.context = context;
	self.commandRouter = self.context.coreCommand;
	self.logger = self.commandRouter.logger;
	this.configManager = this.context.configManager;

	// Setup Debugger
	this.logger.SWdebug = function(data) {
		self.logger.info('[SwitchDebug] ' + data);
	};

	//define shutdown variable
	this.shutdown;

}

// define behaviour on system start up. In our case just read config file
SerialSwitchController.prototype.onVolumioStart = function()
{
	var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
	this.config = new (require('v-conf'))();
	this.config.loadFile(configFile);

	return libQ.resolve();
}

// Volumio needs this
SerialSwitchController.prototype.getConfigurationFiles = function()
{
	return ['config.json'];
}

// define behaviour on plugin activation
SerialSwitchController.prototype.onStart = function() {

	var defer = libQ.defer();

	// initialize output port
	this.serialPortInit();


	// read and parse status once
	socket.emit('getState','');
	socket.once('pushState', this.parseStatus.bind(this));

	// listen to every subsequent status report from Volumio
	// status is pushed after every playback action, so we will be
	// notified if the status changes
	socket.on('pushState', this.parseStatus.bind(this));

	return defer.promise;
};

// define behaviour on plugin deactivation.
SerialSwitchController.prototype.onStop = function() {

	var defer = libQ.defer();
	this.printConfig();
	this.freeSerial();

	return defer.promise;
};


SerialSwitchController.prototype.printConfig = function() {
	this.logger.SWdebug('Port: ' + this.config.get('port_name'));
	this.logger.SWdebug('StartMessage: ' + this.config.get('start_message'));
	this.logger.SWdebug('StopMessage: ' + this.config.get('stop_message'));
	this.logger.SWdebug('Delay: ' + this.config.get('delay'));
}

// initialize Plugin settings page
SerialSwitchController.prototype.getUIConfig = function() {
	var defer = libQ.defer();

	this.printConfig();
	var self = this;

	var lang_code = this.commandRouter.sharedVars.get('language_code');
	this.logger.SWdebug(lang_code);
	this.logger.SWdebug(this.commandRouter);

	this.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
			__dirname+'/i18n/strings_en.json',
			__dirname + '/UIConfig.json')
		.then(function(uiconf)
				{
				uiconf.sections[0].content[0].value = self.config.get('port_name');
				uiconf.sections[0].content[1].value = self.config.get('start_message');
				uiconf.sections[0].content[2].value = self.config.get('stop_message');
				uiconf.sections[0].content[3].value = self.config.get('delay');
				defer.resolve(uiconf);
				})
	.fail(function()
			{
			self.logger.SWdebug("Error reading UIConfig");
			defer.reject(new Error());
			});

	return defer.promise;
};

// define what happens when the user clicks the 'save' button on the settings page
SerialSwitchController.prototype.saveOptions = function(data) {

	var successful = true;
	var old_setting = this.config.get('port_name');

	// save port setting to our config
	this.logger.SWdebug('Saving settings:');
	this.printConfig();

	this.config.set('port_name', data['port_name']);
	this.config.set('start_message', data['start_message']);
	this.config.set('stop_message', data['stop_message']);
	this.config.set('delay', data['delay']);

	try{
		this.freeSerial();
		this.serialPortInit();
	} catch(err) {
		successful = false;
	}
	if(successful){
		// output message about successful saving to the UI
		this.commandRouter.pushToastMessage('success', 'Serial Switch Settings', 'Saved');
	} else {
		// save port setting to old config
		this.config.set('port_name', old_setting);
		this.commandRouter.pushToastMessage('error','Port not accessible', '');
	}

};

// initialize shutdown port to the one that we stored in the config
SerialSwitchController.prototype.serialPortInit = function() {

	var self = this;
	this.serial = new SerialPort(this.config.get('port_name'), function (err) {
			if (err) {
			throw new Error('Error opening serial port');
			} else {
			self.serial.on('error', function(err) {
					self.logger.SWdebug('Error: ', err.message);
					});
			}
			});
};

// a pushState event has happened. Check whether it differs from the last known status and
// switch output port on or off respectively
SerialSwitchController.prototype.parseStatus = function(state) {

	var self = this;
	var delay = (this.config.get('delay') * 1000);
	this.logger.SWdebug('CurState: ' + state.status + ' PrevState: ' + status_amp);

	if(state.status=='play' && state.status!=status_amp){
		clearTimeout(this.OffTimerID);
		status_amp=state.status;
		this.on();
	} else if((state.status=='pause' || state.status=='stop') && (status_amp!='pause' && status_amp!='stop')){
		clearTimeout(this.OffTimerID);
		this.logger.SWdebug('InitTimeout - Serial message-off in: ' + delay + ' ms');
		status_amp=state.status;
		this.OffTimerID = setTimeout(function() {
				self.off();
				}, delay);
	}

};

// switch outport port on
SerialSwitchController.prototype.on = function() {
        var self = this;
	this.logger.SWdebug('Sending ON message to serial');
	this.serial.write(this.config.get('start_message'));
//	this.serial.write("W 1 1 2\r");
//	setTimeout(function() { self.serial.write("W 1 2 7\r"); }, 1000);
};

//switch output port off
SerialSwitchController.prototype.off = function() {
	this.logger.SWdebug('Sending OFF message to serial');
	this.serial.write(this.config.get('stop_message'));
//	this.serial.write("W 1 1 1\r");
};

// stop claiming output port
SerialSwitchController.prototype.freeSerial = function() {
	if (this.serial != null) {
		this.serial.close();
		this.serial = null;
	}
};
