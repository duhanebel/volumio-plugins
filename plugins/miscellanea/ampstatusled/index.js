G'use strict';

// load external modules
var libQ = require('kew');
var io = require('socket.io-client');
var Gpio = require('onoff').Gpio;

var socket = io.connect('http://localhost:3000');


//declare global status variable
var status = 'na';

// Define the AmpStatusLedController class
module.exports = AmpStatusLedController;


function AmpStatusLedController(context) {
  var self = this;

  // Save a reference to the parent commandRouter
  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.commandRouter.logger;
  this.configManager = this.context.configManager;

  // Setup Debugger
  self.logger.ASdebug = function(data) {
    self.logger.info('[AmpStatusLED] ' + data);
  };

  //define shutdown variable
  self.shutdown;

}

// define behaviour on system start up. In our case just read config file
AmpStatusLedController.prototype.onVolumioStart = function()
{
    var self = this;
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);

    return libQ.resolve();
}

// Volumio needs this
AmpStatusLedController.prototype.getConfigurationFiles = function()
{
  return ['config.json'];
}

// define behaviour on plugin activation
AmpStatusLedController.prototype.onStart = function() {
  var self = this;
  var defer = libQ.defer();

    // initialize output port
    self.ampGPIOInit();

    self.setReady();

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
AmpStatusLedController.prototype.onStop = function() {
    var self = this;
    var defer = libQ.defer();

    // we don't have to claim GPIOs any more
    self.freeGPIO();

    return defer.promise;
};

// initialize Plugin settings page
AmpStatusLedController.prototype.getUIConfig = function() {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
                                __dirname+'/i18n/strings_en.json',
                                __dirname + '/UIConfig.json')
    .then(function(uiconf)
          {
          uiconf.sections[0].content[0].value.value = self.config.get('loading_color');
          uiconf.sections[0].content[0].value.label = self.config.get('loading_color');
          uiconf.sections[0].content[1].value.value = self.config.get('ready_color');
          uiconf.sections[0].content[1].value.label = self.config.get('ready_color');
          uiconf.sections[0].content[2].value.value = self.config.get('playing_color');
          uiconf.sections[0].content[2].value.label = self.config.get('playing_color');
          uiconf.sections[0].content[3].value.value = self.config.get('red_gpio');
          uiconf.sections[0].content[3].value.label = self.config.get('red_gpio').toString();
          uiconf.sections[0].content[4].value.value = self.config.get('green_gpio');
          uiconf.sections[0].content[4].value.label = self.config.get('green_gpio').toString();
          uiconf.sections[0].content[5].value.value = self.config.get('blue_gpio');
          uiconf.sections[0].content[5].value.label = self.config.get('blue_gpio').toString();
          defer.resolve(uiconf);
          })
    .fail(function()
          {
          defer.reject(new Error());
          });

    return defer.promise;
};

// define what happens when the user clicks the 'save' button on the settings page
AmpStatusLedController.prototype.saveOptions = function(data) {
    var self = this;
    var successful = true;
    var old_red_gpio = self.config.get('red_gpio');
    var old_green_gpio = self.config.get('green_gpio');
    var old_blue_gpio = self.config.get('blue_gpio');
    // save port setting to our config
    self.logger.ASdebug('Saving Settings');

    self.config.set('loading_color', data['loading_color']['value']);
    self.config.set('ready_color', data['ready_color']['value']);
    self.config.set('playing_color', data['playing_color']['value']);
    self.config.set('red_gpio', data['red_gpio']['value']);
    self.config.set('green_gpio', data['green_gpio']['value']);
    self.config.set('blue_gpio', data['blue_gpio']['value']);

    // unexport GPIOs before constructing new GPIO object
    self.freeGPIO();
    try {
        self.ampGPIOInit()
    } catch(err) {
        successful = false;
    }
    if(successful){
        // output message about successful saving to the UI
        self.commandRouter.pushToastMessage('success', 'Amp Status LED Settings', 'Saved');
        newBootPinValue = self.pinConfForColor(data['loading_color']['value'])
        self.updateBootConfig(newBootPinValue)
    } else {
        // save port setting to old config
        self.config.set('red_gpio', old_red_gpio);
        self.config.set('green_gpio', old_green_gpio);
        self.config.set('blue_gpio', old_blue_gpio);
        self.commandRouter.pushToastMessage('error','Port not accessible', '');
    }

};

// initialize shutdown port to the one that we stored in the config
AmpStatusLedController.prototype.ampGPIOInit = function() {
    var self = this;

    self.redPin = new Gpio(self.config.get('red_gpio'),'out');
    self.greenPin = new Gpio(self.config.get('green_gpio'),'out');
    self.bluePin = new Gpio(self.config.get('blue_gpio'),'out');
};

// a pushState event has happened. Check whether it differs from the last known status and
// switch output port on or off respectively
AmpStatusLedController.prototype.parseStatus = function(state) {
    var self = this;
    self.logger.ASdebug('CurState: ' + state.status + ' PrevState: ' + status);

    if(state.status=='play' && state.status!=status){
        status=state.status;
        self.setPlaying();
    } else if((state.status=='pause' || state.status=='stop') && (status!='pause' && status!='stop')){
       status=state.status
       self.setReady();
    }

};

// switch outport port on
AmpStatusLedController.prototype.setPlaying = function() {
    var self = this;

    self.logger.ASdebug('Togle GPIO LED: Playing');
    self.setLEDColor(self.config.get('playing_color'));
};

//switch output port off
AmpStatusLedController.prototype.setReady = function() {
    var self = this;

    self.logger.ASdebug('Togle GPIO LED: Ready');
    self.setLEDColor(self.config.get('ready_color'));
};

AmpStatusLedController.prototype.setLEDColor = function(colorID) {
   switch(colorID) {
    case 'Red':
        this.redPin.writeSync(1);
        this.greenPin.writeSync(0);
        this.bluePin.writeSync(0);
        break;
    case 'Green':
        this.redPin.writeSync(0);
        this.greenPin.writeSync(1);
        this.bluePin.writeSync(0);
        break;
    case 'Blue':
        this.redPin.writeSync(0);
        this.greenPin.writeSync(0);
        this.bluePin.writeSync(1);
    break;
    case 'Yellow':
        this.redPin.writeSync(1);
        this.greenPin.writeSync(1);
        this.bluePin.writeSync(0);
    break;
    case 'LightBlue':
        this.redPin.writeSync(0);
        this.greenPin.writeSync(1);
        this.bluePin.writeSync(1);
    break;
    case 'Purple':
        this.redPin.writeSync(1);
        this.greenPin.writeSync(0);
        this.bluePin.writeSync(1);
    break;
    default:
        this.logger.ASdebug('Invalid color specified');
    }
}

// stop claiming output port
AmpStatusLedController.prototype.freeGPIO = function() {
    var self = this;

    self.redPin.unexport();
    self.greenPin.unexport();
    self.bluePin.unexport();
};

AmpStatusLedController.prototype.pinConfForColor = function(color) {
  switch(color) {
      case 'Red':
          return "gpio=" + self.config.get('red_gpio') + "=op,dh"
      break;
      case 'Green':
          return "gpio=" + self.config.get('green_gpio') + "=op,dh"
      break;
      case 'Blue':
          return "gpio=" + self.config.get('blue_gpio') + "=op,dh"
      break;
      case 'Yellow':
          return "gpio=" + self.config.get('red_gpio') + "," + self.config.get('green_gpio') + "=op,dh"
      break;
      case 'LightBlue':
          return "gpio=" + self.config.get('blue_gpio') + "," + self.config.get('green_gpio') + "=op,dh"
      break;
      case 'Purple':
          return "gpio=" + self.config.get('blue_gpio') + "," + self.config.get('red_gpio') + "=op,dh"
      break;
  }
}

AmpStatusLedController.prototype.updateBootConfig = function(newValue) {
  var fs = require('fs')
  var boot_config = '/boot/config.txt'
  fs.readFile(boot_config, 'utf8', function (err,data) {
    if (err) {
      return console.log(err);
    }
    var result = data.replace(/^gpio=([0-9]{1,2},*)+=op,dh/, 'newValue');

    fs.writeFile(boot_config, result, 'utf8', function (err) {
       if (err) return console.log(err);
    });
  });
}

