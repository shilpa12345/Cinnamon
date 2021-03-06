// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Cinnamon = imports.gi.Cinnamon;
const Lang = imports.lang;

const Main = imports.ui.main;
const Applet = imports.ui.applet;
const Extension = imports.ui.extension;
const ModalDialog = imports.ui.modalDialog;

// Maps uuid -> metadata object
var appletMeta;
// Maps uuid -> importer object (applet directory tree)
var applets;
// Maps applet_id -> applet objects
const appletObj = {};
var appletsLoaded = false;

// An applet can assume a role
// Instead of hardcoding looking for a particular applet,
// We let applets announce that they can fill a particular
// role, using the 'role' metadata entry.
// For now, just notifications, but could be expanded.
// question - should multiple applets be able to fill
// the same role?
const Roles = {
    NOTIFICATIONS: 'notifications',
    WINDOWLIST: 'windowlist',
    PANEL_LAUNCHER: 'panellauncher'
}

let enabledAppletDefinitions;
let clipboard = [];

function init() {
    appletMeta = Extension.meta;
    applets = Extension.importObjects;

    appletsLoaded = false;
    
    // Load all applet extensions, the applets themselves will be added in finishExtensionLoad
    enabledAppletDefinitions = getEnabledAppletDefinitions();
    for (let uuid in enabledAppletDefinitions.uuidMap) {
        Extension.loadExtension(uuid, Extension.Type.APPLET);
    }
    appletsLoaded = true;
    
    global.settings.connect('changed::enabled-applets', onEnabledAppletsChanged);
}

// Callback for extension.js
function finishExtensionLoad(extension) {
    // Add all applet instances for this extension
    let definitions = enabledAppletDefinitions.uuidMap[extension.uuid];
    if (definitions) {
        for(let i=0; i<definitions.length; i++) {
            if (!addAppletToPanels(extension, definitions[i]))
                return false;
        }
    }
    return true;
}

// Callback for extension.js
function prepareExtensionUnload(extension) {
    // Remove all applet instances for this extension
    for(let applet_id in extension._loadedDefinitions) {
        removeAppletFromPanels(extension._loadedDefinitions[applet_id]);
    }
}

function getEnabledAppletDefinitions() {
    let result = {
        // the raw list from gsettings
        raw: global.settings.get_strv('enabled-applets'),
        // maps uuid -> list of applet definitions
        uuidMap: {},
        // maps applet_id -> single applet definition
        idMap: {}
    };
    
    // Upgrade settings if required
    checkForUpgrade(result.raw);
    
    // Parse all definitions
    for (let i=0; i<result.raw.length; i++) {
        let appletDefinition = getAppletDefinition(result.raw[i]);
        if(appletDefinition) {
            if(!result.uuidMap[appletDefinition.uuid])
                result.uuidMap[appletDefinition.uuid] = [];
            result.uuidMap[appletDefinition.uuid].push(appletDefinition);
            result.idMap[appletDefinition.applet_id] = appletDefinition;
        }
    }
    
    return result;
}

function getAppletDefinition(definition) {
    // format used in gsettings is 'panel:location:order:uuid:applet_id' where:
    // - panel is something like 'panel1',
    // - location is either 'left', 'center' or 'right',
    // - order is an integer representing the order of the applet within the panel/location (i.e. 1st, 2nd etc..).
    // - applet_id is a unique id assigned to the applet instance when added.
    let elements = definition.split(":");
    if (elements.length > 4) {
        let panelId = parseInt(elements[0].slice(5));
        let panel = Main.panelManager.panels[panelId];
        let orientation;
        let order;
        try { order = parseInt(elements[2]); } catch(e) { order = 0; }

        // Panel might not exist. Still keep definition for future use.
        let location;
        if (panel) {
            orientation = panel.bottomPosition ? St.Side.BOTTOM : St.Side.TOP;
            switch (elements[1]){
            case "center":
                location = panel._centerBox;
                break;
            case "right":
                location = panel._rightBox;
                break;
            default: // Let default position be left
                location = panel._leftBox;
            }
        }
        
        return {
            panel: panel,
            panelId: panelId,
            orientation: orientation,
            location: location,
            location_label: elements[1],
            center: elements[1] == "center",
            order: order,
            uuid: elements[3],
            applet_id: elements[4]
        };
    }

    global.logError("Bad applet definition: " + definition);
    return null;
}

function checkForUpgrade(newEnabledApplets) {
    // upgrade if old version
    let nextAppletId = global.settings.get_int("next-applet-id");
    for (let i=0; i<newEnabledApplets.length; i++) {
        let elements = newEnabledApplets[i].split(":");
        if (elements.length == 4) {
            newEnabledApplets[i] += ":" + nextAppletId;
            nextAppletId++;
        }
    }

    if(nextAppletId != global.settings.get_int("next-applet-id")) {
        global.settings.set_int("next-applet-id", nextAppletId);
        global.settings.set_strv('enabled-applets', newEnabledApplets);
        return true;
    }

    return false;
}

function appletDefinitionsEqual(a, b) {
    return ( a.panel == b.panel && a.orientation == b.orientation && a.location == b.location && a.order == b.order);
}

function onEnabledAppletsChanged() {
    try {
        let oldEnabledAppletDefinitions = enabledAppletDefinitions;
        enabledAppletDefinitions = getEnabledAppletDefinitions();
        // Remove all applet instances that do not exist in the definition anymore.
        for (let applet_id in oldEnabledAppletDefinitions.idMap) {
            if(!enabledAppletDefinitions.idMap[applet_id]) {
                removeAppletFromPanels(oldEnabledAppletDefinitions.idMap[applet_id]);
            }
        }
        
        // Unload all applet extensions that do not exist in the definition anymore.
        for (let uuid in oldEnabledAppletDefinitions.uuidMap) {
            if(!enabledAppletDefinitions.uuidMap[uuid]) {
                Extension.unloadExtension(uuid);
            }
        }
        
        // Add or move applet instances of already loaded applet extensions
        for (let applet_id in enabledAppletDefinitions.idMap) {
            let newDef = enabledAppletDefinitions.idMap[applet_id];
            let oldDef = oldEnabledAppletDefinitions.idMap[applet_id];
            
            if(!oldDef || !appletDefinitionsEqual(newDef, oldDef)) {
                let extension = Extension.objects[newDef.uuid];
                if(extension) {
                    addAppletToPanels(extension, newDef);
                }
            }
        }
        
        // Make sure all applet extensions are loaded.
        // Once loaded, the applets will add themselves via finishExtensionLoad
        for (let uuid in enabledAppletDefinitions.uuidMap) {
            Extension.loadExtension(uuid, Extension.Type.APPLET);
        }
    }
    catch(e) {
        global.logError('Failed to refresh list of applets', e);
    }

    Main.statusIconDispatcher.redisplay();
}

function removeAppletFromPanels(appletDefinition) {
    let applet = appletObj[appletDefinition.applet_id];
    if (applet) {
        try {
            applet._onAppletRemovedFromPanel();
        } catch (e) {
            global.logError("Error during on_applet_removed_from_panel() call on applet: " + appletDefinition.uuid + "/" + appletDefinition.applet_id, e);
        }

        if (applet._panelLocation != null) {
            applet._panelLocation.remove_actor(applet.actor);
            applet._panelLocation = null;
        }

        delete applet._extension._loadedDefinitions[appletDefinition.applet_id];
        delete appletObj[appletDefinition.applet_id];

        _removeAppletConfigFile(appletDefinition.uuid, appletDefinition.applet_id);

        /* normal occurs during _onAppletRemovedFromPanel, but when a panel is removed,
         * appletObj hasn't had the instance removed yet, so let's run it one more time
         * here when everything has been updated.
         */
        callAppletInstancesChanged(appletDefinition.uuid);
    }
}

function _removeAppletConfigFile(uuid, instanceId) {
    let config_path = (GLib.get_home_dir() + "/" +
                               ".cinnamon" + "/" +
                                 "configs" + "/" +
                                      uuid + "/" +
                                instanceId + ".json");
    let file = Gio.File.new_for_path(config_path);
    if (file.query_exists(null)) {
        try {
            file.delete(null, null);
        } catch (e) {
            global.logError("Problem removing applet config file during cleanup.  UUID is " + uuid + " and filename is " + config_path);
        }
    }
}

function addAppletToPanels(extension, appletDefinition) {
    if (!appletDefinition.panel) return true;

    try {
        // Create the applet
        let applet = createApplet(extension, appletDefinition);
        if(applet == null)
            return false;
        
        // Now actually lock the applets role and set the provider
        extension.lockRole(applet);

        applet._order = appletDefinition.order;
        applet._extension = extension;

        // Remove it from its previous panel location (if it had one)
        if (applet._panelLocation != null) {
            applet._panelLocation.remove_actor(applet.actor);
            applet._panelLocation = null;
        }

        // Add it to its new panel location
        let children = appletDefinition.location.get_children();
        let appletsToMove = [];
        for (let i=0; i<children.length;i++) {
            let child = children[i];
            if ((typeof child._applet !== "undefined") && (child._applet instanceof Applet.Applet)) {
                if (appletDefinition.order < child._applet._order) {
                    appletsToMove.push(child);
                }
            }
        }

        for (let i=0; i<appletsToMove.length; i++) {
            appletDefinition.location.remove_actor(appletsToMove[i]);
        }

        if (appletDefinition.center) {
            appletDefinition.location.add(applet.actor, {x_align: St.Align.CENTER_SPECIAL});
        } else {
            appletDefinition.location.add(applet.actor);
        }

        applet._panelLocation = appletDefinition.location;
        for (let i=0; i<appletsToMove.length; i++) {
            appletDefinition.location.add(appletsToMove[i]);
        }
        
        if(!extension._loadedDefinitions) {
            extension._loadedDefinitions = {};
        }
        extension._loadedDefinitions[appletDefinition.applet_id] = appletDefinition;

        applet.on_applet_added_to_panel_internal(appletsLoaded);

        return true;
    }
    catch(e) {
        extension.unlockRole();
        extension.logError('Failed to load applet: ' + appletDefinition.uuid + "/" + appletDefinition.applet_id, e);
        return false;
    }
}

function get_role_provider(role) {
    if (Extension.Type.APPLET.roles[role]) {
        return Extension.Type.APPLET.roles[role].roleProvider;
    }
    return null;
}

function get_role_provider_exists(role) {
    return get_role_provider(role) != null;
}

function createApplet(extension, appletDefinition) {
    if (!appletDefinition.panel) return null;

    let applet_id = appletDefinition.applet_id;
    let orientation = appletDefinition.orientation;
    let panel_height =  appletDefinition.panel.actor.get_height();
    
    if (appletObj[applet_id] != undefined) {
        global.log(applet_id + ' applet already loaded');
        if (appletObj[applet_id]._panelHeight != panel_height) {
            appletObj[applet_id].setPanelHeight(panel_height);
        }
        appletObj[applet_id].setOrientation(orientation);
        return appletObj[applet_id];
    }
    
    let applet;
    try {
        applet = extension.module.main(extension.meta, orientation, panel_height, applet_id);
    } catch (e) {
        extension.logError('Failed to evaluate \'main\' function on applet: ' + appletDefinition.uuid + "/" + appletDefinition.applet_id, e);
        return null;
    }

    appletObj[applet_id] = applet;
    applet._uuid = extension.uuid;
    applet._meta = extension.meta;
    applet.instance_id = applet_id;
    applet.panel = appletDefinition.panel;

    applet.finalizeContextMenu();

    return(applet);
}

function _removeAppletFromPanel(uuid, applet_id) {
    let enabledApplets = enabledAppletDefinitions.raw;
    for (let i=0; i<enabledApplets.length; i++) {
        let appletDefinition = getAppletDefinition(enabledApplets[i]);
        if (appletDefinition) {
            if (uuid == appletDefinition.uuid && applet_id == appletDefinition.applet_id) {
                let newEnabledApplets = enabledApplets.slice(0);
                newEnabledApplets.splice(i, 1);
                global.settings.set_strv('enabled-applets', newEnabledApplets);
                break;
            }
        }
    }
}

function saveAppletsPositions() {
    let zones_strings = ["left", "center", "right"];
    let allApplets = new Array();
    for (var i in Main.panelManager.panels){
        let panel = Main.panelManager.panels[i];
        if (!panel) continue;
        for (var j in zones_strings){
            let zone_string = zones_strings[j];
            let zone = panel["_"+zone_string+"Box"];
            let children = zone.get_children();
            for (var k in children) if (children[k]._applet) allApplets.push(children[k]._applet);
        }
    }
    let applets = new Array();
    for (var i in Main.panelManager.panels){
        let panel = Main.panelManager.panels[i];
        if (!panel)
            continue;

        let panel_string = "panel" + i;

        for (var j in zones_strings){
            let zone_string = zones_strings[j];
            let zone = panel["_"+zone_string+"Box"];
            for (var k in allApplets){
                let applet = allApplets[k];
                let appletZone;
                if (applet._newPanelLocation != null)
                    appletZone = applet._newPanelLocation;
                else
                    appletZone = applet._panelLocation;
                let appletOrder;
                if (applet._newOrder != null)
                    appletOrder = applet._newOrder;
                else
                    appletOrder = applet._order;

                if (appletZone == zone)
                    applets.push(panel_string+":"+zone_string+":"+appletOrder+":"+applet._uuid+":"+applet.instance_id);
            }
        }
    }
    for (var i in allApplets){
        allApplets[i]._newPanelLocation = null;
        allApplets[i]._newOrder = null;
    }
    global.settings.set_strv('enabled-applets', applets);
}

function updateAppletPanelHeights(force_recalc) {
    if(!enabledAppletDefinitions)
        return;
    
    for (let applet_id in enabledAppletDefinitions.idMap) {
        if (appletObj[applet_id]) {
            let appletDefinition = enabledAppletDefinitions.idMap[applet_id];
            let newheight = appletDefinition.panel.actor.get_height();
            if (appletObj[applet_id]._panelHeight != newheight || force_recalc) {
                appletObj[applet_id].setPanelHeight(newheight);
            }
        }
    }
}

// Deprecated, kept for compatibility reasons
function _find_applet(uuid) {
    return Extension.findExtensionDirectory(uuid, Extension.Type.APPLET);
}

function get_object_for_instance (appletId) {
    if (appletId in appletObj) {
        return appletObj[appletId];
    } else {
        return null;
    }
}

function get_object_for_uuid (uuid) {
    for (let instanceid in appletObj) {
        if (appletObj[instanceid]._uuid == uuid) {
            return appletObj[instanceid]
        }
    }
    return null;
}


/**
 * loadAppletsOnPanel:
 * @panel (Panel.Panel): The panel
 *
 * Loads all applets on the panel if not loaded
 */
function loadAppletsOnPanel(panel) {
    let orientation = panel.bottomPosition ? St.Side.BOTTOM : St.Side.TOP;
    let definition;

    for (let applet_id in enabledAppletDefinitions.idMap){
        definition = enabledAppletDefinitions.idMap[applet_id];
        if(definition.panelId == panel.panelId) {
            let location;
            // Update appletDefinition
            switch (definition.location_label){
            case "center":
                location = panel._centerBox;
                break;
            case "right":
                location = panel._rightBox;
                break;
            default: // Let default position be left
                location = panel._leftBox;
            }

            definition.panel = panel;
            definition.location = location;
            definition.orientation = orientation;

            let extension = Extension.objects[definition.uuid];
            if(extension) {
                addAppletToPanels(extension, definition);
            }
        }
    }
}

/**
 * updateAppletsOnPanel:
 * @panel (Panel.Panel): The panel
 *
 * Updates the definition, orientation and height of applets on the panel
 */
function updateAppletsOnPanel (panel) {
    let height = panel.actor.get_height();
    let orientation = panel.bottomPosition ? St.Side.BOTTOM : St.Side.TOP;
    let definition;

    for (let applet_id in enabledAppletDefinitions.idMap){
        definition = enabledAppletDefinitions.idMap[applet_id];
        if(definition.panel == panel) {
            let location;
            switch (definition.location_label[1]){
            case "center":
                location = panel._centerBox;
                break;
            case "right":
                location = panel._rightBox;
                break;
            default: // Let default position be left
                location = panel._leftBox;
            }

            definition.location = location;
            definition.orientation = orientation;

            if (appletObj[applet_id]) {
                appletObj[applet_id].setPanelHeight(height);
                appletObj[applet_id].setOrientation(orientation);
            }
        }
    }
}

/**
 * unloadAppletsOnPanel:
 * @panel (Panel.Panel): The panel
 *
 * Unloads all applets on the panel
 */
function unloadAppletsOnPanel (panel) {
    for (let applet_id in enabledAppletDefinitions.idMap){
        if(enabledAppletDefinitions.idMap[applet_id].panel == panel) {
            removeAppletFromPanels(enabledAppletDefinitions.idMap[applet_id]);
        }
    }
}

function copyAppletConfiguration(panelId) {
    let def = enabledAppletDefinitions.idMap;
    clipboard = [];
    for (let i in def) {
        if (def[i].panelId == panelId) {
            clipboard.push(def[i]);
        }
    }
}

function clearAppletConfiguration(panelId) {
    let raw = global.settings.get_strv("enabled-applets");

    // Remove existing applets on panel
    let i = raw.length;
    while(i--) { // Do a reverse loop to prevent skipping items after splicing
        if (raw[i].split(":")[0].slice(5) == panelId)
            raw.splice(i,1);
    }
    global.settings.set_strv("enabled-applets", raw);
}

function pasteAppletConfiguration(panelId) {
    let raw = global.settings.get_strv("enabled-applets");

    // Remove existing applets on panel
    let i = raw.length;
    while(i--) { // Do a reverse loop to prevent skipping items after splicing
        if (raw[i].split(":")[0].slice(5) == panelId)
            raw.splice(i,1);
    }

    let skipped = false;
    let len = clipboard.length;
    let nextId = global.settings.get_int("next-applet-id");
    for (let i = 0; i < len; i++) {
        let max = Extension.get_max_instances(clipboard[i].uuid);
        if (max == -1) {
            raw.push("panel" + panelId + ":" + clipboard[i].location_label + ":" + clipboard[i].order + ":" + clipboard[i].uuid + ":" + nextId);
            nextId ++;
            continue;
        }
        let curr = enabledAppletDefinitions.uuidMap[clipboard[i].uuid];
        let count = curr.length;
        if (count >= max) { // If we have more applets that allowed, we see if we any of them are removed above
            let i = count;
            while (i--) { // Do a reverse loop because the value of count will change
                if (curr[i].panelId == panelId) count --;
            }
        }

        if (count < max) {
            raw.push("panel" + panelId + ":" + clipboard[i].location_label + ":" + clipboard[i].order + ":" + clipboard[i].uuid + ":" + nextId);
            nextId ++;
        } else {
            skipped = true;
        }
    }
    global.settings.set_int("next-applet-id", nextId);
    global.settings.set_strv("enabled-applets", raw);

    if (skipped) {
        let dialog = new ModalDialog.NotifyDialog(_("Certain applets do not allow multiple instances and were not copied") + "\n\n");
        dialog.open();
    }
}

function getRunningInstancesForUuid(uuid) {
    if(!enabledAppletDefinitions)
        return null;

    let result = [];

    for (let applet_id in enabledAppletDefinitions.idMap) {
        if (appletObj[applet_id]) {
            if (uuid == appletObj[applet_id]._uuid) {
                result.push(appletObj[applet_id]);
            }
        }
    }

    return result
}

function callAppletInstancesChanged(uuid) {
    for (let applet_id in enabledAppletDefinitions.idMap) {
        if (appletObj[applet_id]) {
            if (uuid == appletObj[applet_id]._uuid) {
                appletObj[applet_id].on_applet_instances_changed();
            }
        }
    }
}

