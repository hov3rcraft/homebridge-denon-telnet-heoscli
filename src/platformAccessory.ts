import type { CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';

import type { DenonTelnetPlatform } from './platform.js';

import { DOMParser } from '@xmldom/xmldom'
import { PromiseTimeoutException } from './promiseTimeoutException.js';
import { DenonTelnetClientAvrControl } from './denonTelnetClientAvrControl.js';
import { DenonTelnetMode, IDenonTelnetClient, RaceStatus } from './denonTelnetClient.js';
import { DenonTelnetClientHeosCli } from './denonTelnetClientHeosCli.js';
import { DenonTelnetClientHybrid } from './denonTelnetClientHybrid.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class DenonTelnetAccessory {
  private static readonly CALLBACK_TIMEOUT = 1500;
  private static readonly TELNET_CONNECTION_TIMEOUT = 60000;

  private readonly platform: DenonTelnetPlatform;
  private readonly accessory: PlatformAccessory;
  private readonly telnetClient: IDenonTelnetClient;
  private readonly informationService: Service;
  private readonly switchService: Service;
  private readonly log: Logger;

  private readonly name: string;
  private readonly ip: string;
  private readonly serialNumber: string;
  private readonly telnetMode: DenonTelnetMode;

  constructor(platform: DenonTelnetPlatform, accessory: PlatformAccessory, config: any, log: Logger) {
    log.debug('Initializing DenonTelnetAccessory...');

    this.platform = platform;
    this.accessory = accessory;
    this.log = log;

    this.name = accessory.displayName;
    this.ip = config.ip;
    this.serialNumber = config.serialNumber;
    this.telnetMode = DenonTelnetMode[config.controlMode as keyof typeof DenonTelnetMode];

    // set accessory information
    this.informationService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    this.informationService.getCharacteristic(this.platform.Characteristic.Identify)
      .onSet(this.setIdentify.bind(this));
    this.informationService.setCharacteristic(this.platform.Characteristic.Name, this.name);
    this.informationService.setCharacteristic(this.platform.Characteristic.SerialNumber, this.serialNumber);
    this.informationService.setCharacteristic(this.platform.Characteristic.Manufacturer, "unknown");
    this.informationService.setCharacteristic(this.platform.Characteristic.Model, "unknown");
    this.informationService.setCharacteristic(this.platform.Characteristic.FirmwareRevision, "unknown");
    this.fetchMetadataAios();

    // add on/off switch
    this.switchService = this.accessory.getService(`${this.name} Switch`) || this.accessory.addService(this.platform.Service.Switch, `${this.name} Switch`);
    this.switchService.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));


    // choose appropriate telnet client
    switch (this.telnetMode) {
      case DenonTelnetMode.AVRCONTROL:
        this.telnetClient = new DenonTelnetClientAvrControl(
          this.serialNumber,
          this.ip,
          DenonTelnetAccessory.TELNET_CONNECTION_TIMEOUT,
          this.callbackOn.bind(this),
          this.log.debug.bind(this.log)
        );
        break;
      case DenonTelnetMode.HEOSCLI:
        this.telnetClient = new DenonTelnetClientHeosCli(
          this.serialNumber,
          this.ip,
          DenonTelnetAccessory.TELNET_CONNECTION_TIMEOUT,
          this.callbackOn.bind(this),
          this.log.debug.bind(this.log)
        );
        break;
      case DenonTelnetMode.HYBRID:
        this.telnetClient = new DenonTelnetClientHybrid(
          this.serialNumber,
          this.ip,
          DenonTelnetAccessory.TELNET_CONNECTION_TIMEOUT,
          this.callbackOn.bind(this),
          this.log.debug.bind(this.log)
        )
        break;
      case DenonTelnetMode.AUTO:
        throw new Error("AUTO control mode not implemented yet");
    }

    this.log.info('Finished initializing accessory:', this.name);
  }

  private fetchMetadataAios() {
    fetch(`http://${this.ip}:60006/upnp/desc/aios_device/aios_device.xml`)
      .then(response => {
        if (!response.ok) {
          this.log.debug(`Received a non-200 status code while connecting to a new device's location href (status code: ${response.status}).`);
        }

        response.text().then(text => {
          const parser = new DOMParser();
          const xmlDoc = parser.parseFromString(text, "text/xml");

          this.informationService.setCharacteristic(this.platform.Characteristic.Manufacturer, xmlDoc.getElementsByTagName("device")[0]?.getElementsByTagName("manufacturer")[0]?.textContent || "unknown");
          this.informationService.setCharacteristic(this.platform.Characteristic.Model, xmlDoc.getElementsByTagName("device")[0]?.getElementsByTagName("modelName")[0]?.textContent || "unknown");

          const d_list = (xmlDoc.getElementsByTagName("device")[0]?.getElementsByTagName("deviceList")[0]?.getElementsByTagName("device") || []);
          for (const d of d_list) {
            let firmware_version = d.getElementsByTagName("firmware_version")[0]?.textContent;
            if (firmware_version) {
              this.informationService.setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmware_version || "unknown");
              break;
            }
          };
        });
      })
      .catch(() => {
        this.log.warn(`An error occured while connecting to ${this.name}'s location href.`);
      });
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   */
  async getOn(): Promise<CharacteristicValue> {
    let raceStatus = new RaceStatus();

    try {
      this.log.debug(`getPower for ${this.name}. [race id: ${raceStatus.raceId}]`);
      return await Promise.race([
        this.telnetClient.getPower(raceStatus),
        new Promise<boolean>((resolve, reject) => {
          setTimeout(() => {
            raceStatus.setRaceOver();
            reject(new PromiseTimeoutException(DenonTelnetAccessory.CALLBACK_TIMEOUT))
          }, DenonTelnetAccessory.CALLBACK_TIMEOUT);
        })
      ]);
    } catch (error) {
      if ((error instanceof PromiseTimeoutException)) {
        this.log.debug(`${this.name} lost its promise race for getOn(). [race id: ${raceStatus.raceId}]`);
      } else {
        this.log.error(`An error occured while getting power status for ${this.name}. [race id: ${raceStatus.raceId}]`, error);
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  getManufacturer(): CharacteristicValue {
    return this.platform.ssdpDiscoveredDevices.get(this.serialNumber)?.details?.device?.manufacturer || 'unknown';
  }

  getModel(): CharacteristicValue {
    return this.platform.ssdpDiscoveredDevices.get(this.serialNumber)?.details?.device?.modelName || 'unknown';
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(state: CharacteristicValue) {
    this.log.debug(`setPower for ${this.name} set to ${state}`);

    try {
      return await Promise.race([
        this.telnetClient.setPower(state as boolean),
        new Promise<void>((resolve, reject) => {
          setTimeout(() => reject(new PromiseTimeoutException(DenonTelnetAccessory.CALLBACK_TIMEOUT)), DenonTelnetAccessory.CALLBACK_TIMEOUT);
        })
      ]);
    } catch (error) {
      if ((error instanceof PromiseTimeoutException)) {
        this.log.warn(`${this.name} seems to be unresponsive.`);
      } else {
        this.log.error(`An error occured while setting power status for ${this.name}.`, error);
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  setIdentify(value: any) {
    this.log.info('Triggered SET Identify:', value);
  }

  /**
   * Handles characteristic updates from the API
   */
  private callbackOn(state: CharacteristicValue) {
    this.switchService.updateCharacteristic(this.platform.Characteristic.On, state);
  }
}
