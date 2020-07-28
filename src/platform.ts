import { APIEvent, AccessoryEventTypes, UUID } from 'homebridge';
import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { RGBStrip } from './accessories/RGBStrip';
import { Discover } from './magichome-interface/Discover';
import { Transport } from './magichome-interface/Transport';
import broadcastAddress from 'broadcast-address';
import systemInformation from 'systeminformation';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class HomebridgeMagichomeDynamicPlatform implements DynamicPlatformPlugin {
  public readonly Service = this.api.hap.Service;
  public readonly Characteristic = this.api.hap.Characteristic;
  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing:', this.config.name);
    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      log.debug('Executed didFinishLaunching callback');

      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {


    this.log.debug('Loading accessory from cache...', accessory.context.displayName);

    // set cached accessory as not recently seen 
    // if found later to be a match with a discovered device, will change to true
    accessory.context.restartsSinceSeen++;

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
    
 
  }

  /**
   * Accessories are added by one of three Methods:
   * Method One: New devices that were seen after scanning the network and are registered for the first time
   * Method Two: Cached devices that were seen after scanning the network and are added while checking for ip discrepancies 
   * Method Three: Cached devices that were not seen after scanning the network but are still added with a warning to the user
   */



  async discoverDevices() {
    const defaultInterface = await systemInformation.networkInterfaceDefault();
    const broadcastIPAddress = broadcastAddress(defaultInterface.toString());

    let registeredDevices = 0;
    let newDevices = 0;
    let unseenDevices = 0;
    const discover = new Discover(this.log, this.config);
    this.log.info('Scanning broadcast-address: %o on interface: %o for Magichome lights... \n', broadcastIPAddress, defaultInterface);

    let devices: any = await discover.scan(2000);
    let scans = 0;
    while(devices.length === 0 && scans <5){
      this.log.warn('( Scan: %o ) Found zero devices... rescanning...', scans + 1);
      devices = await discover.scan(2000);
      scans++;
    }

    if (devices.length == 0){
      this.log.warn('\nFound zero devices! Will load cached devices if they exist.\n');
    } else {
      this.log.info('\nFound %o devices.\n', devices.length);
    }


    
    try {
      // loop over the discovered devices and register each one if it has not already been registered
      for (const device of devices) {  

        // generate a unique id for the accessory this should be generated from
        // something globally unique, but constant, for example, the device serial
        // number or MAC address
        const uuid = this.api.hap.uuid.generate(device.uniqueId);

        // check that the device has not already been registered by checking the
        // cached devices we stored in the `configureAccessory` method above
        const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);  


        /**
   * Accessory Generation Method One: UUID has not been seen before. Register new accessory.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
        if (!existingAccessory) { 

          const deviceType = await discover.createAccessory(device);

          //create a new transport object so we have access to devices state
          //this is neccessary to determine the lightVersion
          const transport = new Transport(device.ipAddress, this.config);
          //retrieve the device's state
  
          const state = await transport.getState(1000);
          device.initialState = state.debugBuffer;
    
          //check if device is on blacklist or is not on whitelist
          if(!this.isAllowed(device.uniqueId)){
            this.log.warn('Warning! New device with Unique ID: %o is blacklisted or is not whitelisted.\n', 
              device.uniqueId);

            //exit the loop
            continue;
          }

          // create a new accessory
          const accessory = new this.api.platformAccessory(deviceType.convenientName, uuid);
            
          // create the accessory handler
          // this is imported from `platformAccessory.ts`
          new RGBStrip(this, accessory, this.config);

          accessory.context.deviceType = deviceType;
          accessory.context.displayName = deviceType.convenientName;

          // store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = device; 

          // saved a distint cached version of the IP address to compare in future restarts
          accessory.context.cachedIPAddress = device.ipAddress;

          // set its restart prune counter to 0 as it has been seen this session
          accessory.context.restartsSinceSeen = 0;

          // create the accessory handler
          // this is imported from `platformAccessory.ts`
          new RGBStrip(this, accessory, this.config);

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          registeredDevices++;
          newDevices++;

          this.log.info('\nRegistering new accessory %o \nModel: %o \nUnique ID: %o \nIP-Address: %o \nVersion %o \nVersion Modifier: %o\n',  
            accessory.context.displayName,
            device.modelNumber, 
            device.uniqueId, 
            device.ipAddress,
            device.lightVersion,
            device.lightVersionModifier);

          // push into accessory cache
          this.accessories.push(accessory);




        
 
        } else {
          // the device has already been registered and will need
          // to ensure the ip address (or other custom variables) are still identical
        
          // set its restart prune counter to 0 as it has been seen this session
          existingAccessory.context.restartsSinceSeen = 0;
          //=================================================
          // Start IP Discrepency //
          // test if the existing cached accessory ip address matches the discovered
          // accessory ip address if not, replace it
          if (existingAccessory.context.cachedIPAddress !== device.ipAddress) {

            this.log.warn('Ip address discrepancy found for accessory:' , existingAccessory.context.displayName);
            this.log.warn('Expected ip address: ', existingAccessory.context.cachedIPAddress);
            this.log.warn('Discovered ip address: ', device.ipAddress);

            // overwrite the ip address of the existing accessory to the newly disovered ip address
            existingAccessory.context.cachedIPAddress = device.ipAddress;

            this.log.warn('Ip address successfully reassigned to: %o\n ', existingAccessory.context.cachedIPAddress);
          }
          
          if(!this.isAllowed(existingAccessory.context.device.uniqueId)){
            this.log.warn('Warning! Accessory: %o will be pruned as its Unique ID: %o is blacklisted or is not whitelisted.\n', 
              existingAccessory.context.displayName, existingAccessory.context.device.uniqueId);
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
            continue;
          }
          //=================================================
          // End IP Discrepency //
        
          this.log.info('\nRegistering cached accessory %o \nModel: %o \nUnique ID: %o \nIP-Address: %o \nVersion %o \nVersion Modifier: %o\n',  
            existingAccessory.context.displayName,
            existingAccessory.context.device.modelNumber, 
            existingAccessory.context.device.uniqueId, 
            existingAccessory.context.cachedIPAddress,
            existingAccessory.context.device.lightVersion,
            existingAccessory.context.device.lightVersionModifier);
          // create the accessory handler
          new RGBStrip(this, existingAccessory,this.config);   
          registeredDevices++;
          // udpate the accessory to your platform
          this.api.updatePlatformAccessories([existingAccessory]);
        } 
      }
    //=================================================
    // End Cached Devices //
    } catch (error) {
      this.log.error(error);
     
    }
   
    //***************** Device Pruning Start *****************//
    
    //if config settings are enabled, devices that are no longer seen
    //will be pruned, removing them from the cache. Usefull for removing
    //unplugged or unresponsive accessories
    for (const accessory of this.accessories){
      if(accessory.context.displayName.toString().toLowerCase().includes('delete')){
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.warn('Successfully pruned accessory: ', accessory.context.displayName,
          'due to being marked for deletion\n');
        continue;
        
      //if the config parameters for pruning are set to true, prune any devices that haven't been seen
      //for more restarts than the accepted ammount
      } else if(this.config.pruning.pruneMissingCachedAccessories || this.config.pruning.pruneAllAccessoriesNextRestart){
        if(accessory.context.restartsSinceSeen >= this.config.pruning.restartsBeforeMissingAccessoriesPruned || this.config.pruning.pruneAllAccessoriesNextRestart){
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.log.warn('Successfully pruned accessory:', accessory.context.displayName,
            'which had not being seen for (',accessory.context.restartsSinceSeen,') restart(s).\n');
          continue;
        }
      }
      //simple warning to notify user that their accessory hasn't been seen in n restarts
      if(accessory.context.restartsSinceSeen > 0){
        //logic for removing blacklisted devices
    
        if(!this.isAllowed(accessory.context.device.uniqueId)){
          this.log.warn('Warning! Accessory: %o will be pruned as its Unique ID: %o is blacklisted or is not whitelisted.\n', 
            accessory.context.displayName, accessory.context.device.uniqueId);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          continue;
        }


        this.log.warn('\nWarning! Continuing to register cached accessory %o despite not being seen for %o restarts. \nModel: %o \nUnique ID: %o \nIP-Address: %o\n Version %o \nVersion Modifier: %o \n',  
          accessory.context.displayName,
          accessory.context.restartsSinceSeen,
          accessory.context.device.modelNumber,
          accessory.context.device.uniqueId, 
          accessory.context.cachedIPAddress,
          accessory.context.device.lightVersion,
          accessory.context.device.lightVersionModifier);
        // create the accessory handler
        new RGBStrip(this, accessory,this.config);   

        // udpate the accessory to your platform
        this.api.updatePlatformAccessories([accessory]);
        registeredDevices++;
        unseenDevices++;
      }
    
    } 

    
    this.log.info('\nRegistered %o Magichome device(s). \nNew devices: %o \nCached devices that were seen this restart: %o \nCached devices that were not seen this restart: %o\n',
      registeredDevices, 
      newDevices, 
      registeredDevices-newDevices-unseenDevices, 
      unseenDevices);
  }//discoveredDevices

  async registerDeviceType(){
    //determine which class we will create the discovered device as.
  }

  isAllowed(uniqueId){

    let isAllowed = true;
    try {

      if(this.config.deviceManagement.blacklistedUniqueIDs !== undefined 
        && this.config.deviceManagement.blacklistOrWhitelist !== undefined){

        if (((this.config.deviceManagement.blacklistedUniqueIDs).includes(uniqueId) && (this.config.deviceManagement.blacklistOrWhitelist).includes('blacklist')) 
   || (!(this.config.deviceManagement.blacklistedUniqueIDs).includes(uniqueId)) && (this.config.deviceManagement.blacklistOrWhitelist).includes('whitelist')){
          isAllowed = false; 
        }
      }
    } catch (error) {
      this.log.debug(error);
    }

    return isAllowed;
  }
  
}//ZackneticMagichomePlatform class
  