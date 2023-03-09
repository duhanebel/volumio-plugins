'use strict';

// load external modules
var libQ = require('kew');
var io = require('socket.io-client');
const { spawnSync } = require('child_process');

var socket = io.connect('http://localhost:3000');

//declare global status variable
var status_amp = 'na';

// Define the ScreenSwitchController class
module.exports = ScreenSwitchController;

function ScreenSwitchController(context) {
	var self = this; 

	// Save a reference to the parent commandRouter
	self.context = context;
	self.commandRouter = self.context.coreCommand;
	self.logger = self.commandRouter.logger;
	this.configManager = this.context.configManager;

	// Setup Debugger
	this.logger.SWdebug = function(data) {
		self.logger.info('[ScreenSwitchDebug] ' + data);
	};

	//define shutdown variable
	this.shutdown;

}

// define behaviour on system start up. In our case just read config file
ScreenSwitchController.prototype.onVolumioStart = function()
{
	var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
	this.config = new (require('v-conf'))();
	this.config.loadFile(configFile);

	return libQ.resolve();
}

// Volumio needs this
ScreenSwitchController.prototype.getConfigurationFiles = function()
{
	return ['config.json'];
}

// define behaviour on plugin activation
ScreenSwitchController.prototype.onStart = function() {
	var self = this
	var defer = libQ.defer();

	// read and parse status once
	socket.emit('getState','');
	socket.once('pushState', self.parseStatus.bind(self));

	// listen to every subsequent status report from Volumio
	// status is pushed after every playback action, so we will be
	// notified if the status changes
	socket.on('pushState', self.parseStatus.bind(self));

	defer.resolve();
	return defer.promise;
};

// define behaviour on plugin deactivation.
ScreenSwitchController.prototype.onStop = function() {

	var defer = libQ.defer();
	this.printConfig();
	return defer.promise;
};


ScreenSwitchController.prototype.printConfig = function() {
	this.logger.SWdebug('DisplayNumber: ' + this.config.get('display_number'));
	this.logger.SWdebug('Delay: ' + this.config.get('delay'));
}

// initialize Plugin settings page
ScreenSwitchController.prototype.getUIConfig = function() {
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
				uiconf.sections[0].content[0].value = self.config.get('display_number');
				uiconf.sections[0].content[1].value = self.config.get('delay');
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
ScreenSwitchController.prototype.saveOptions = function(data) {

	var successful = true;

	// save port setting to our config
	this.logger.SWdebug('Saving settings:');
	this.printConfig();

	this.config.set('display_number', data['display_number']);
	this.config.set('delay', data['delay']);

//	try{
//		this.serialPortInit();
//	} catch(err) {
//		successful = false;
//	}
	if(successful){
		// output message about successful saving to the UI
		this.commandRouter.pushToastMessage('success', 'Screen switch Settings', 'Saved');
	} else {
		// save port setting to old config
		//this.config.set('port_name', old_setting);
		this.commandRouter.pushToastMessage('error','Screen not accessible', '');
	}

};

// a pushState event has happened. Check whether it differs from the last known status and
// switch output port on or off respectively
ScreenSwitchController.prototype.parseStatus = function(state) {

	var self = this;
	var delay = (this.config.get('delay') * 1000);
	this.logger.SWdebug('CurState: ' + state.status + ' PrevState: ' + status_amp);

	if(state.status=='play' && state.status!=status_amp){
		clearTimeout(this.OffTimerID);
		status_amp=state.status;
		this.on();
	} else if((state.status=='pause' || state.status=='stop') && (status_amp!='pause' && status_amp!='stop')){
		clearTimeout(this.OffTimerID);
		this.logger.SWdebug('InitTimeout - Screen message-off in: ' + delay + ' ms');
		status_amp=state.status;
		this.OffTimerID = setTimeout(function() {
				self.off();
				}, delay);
	}
};

// switch outport port on
ScreenSwitchController.prototype.on = function() {
        var self = this;
	this.logger.SWdebug('Turning on screen');
	const cmd = spawnSync('xset', ['-display', this.config.get('display_number'), 'dpms', 'force', 'on']);
};

//switch output port off
ScreenSwitchController.prototype.off = function() {
	this.logger.SWdebug('Turning off screen');
	const cmd = spawnSync('xset', ['-display', this.config.get('display_number'), 'dpms', 'force', 'off']);
};

