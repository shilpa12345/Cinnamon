#!/usr/bin/env python2

from SettingsWidgets import *
from gi.repository import Gtk

class Module:
    name = "calendar"
    comment = _("Manage date and time settings")
    category = "prefs"

    def __init__(self, content_box):
        keywords = _("time, date, calendar, format, network, sync")
        self.sidePage = SidePage(_("Date & Time"), "cs-date-time", keywords, content_box, module=self)

    def on_module_selected(self):
        if not self.loaded:
            print "Loading Calendar module"

            page = SettingsPage()
            self.sidePage.add_widget(page)

            try:
                settings = page.add_section(_("Settings"))
                widget = SettingsWidget()
                content = self.sidePage.content_box.c_manager.get_c_widget("datetime")
                widget.pack_start(content, False, False, 0)
                settings.add_row(widget)

            except Exception, detail:
                print detail

            settings = page.add_section(_("Format"))
            settings.add_row(GSettingsSwitch(_("Use 24h clock"), "org.cinnamon.desktop.interface", "clock-use-24h"))
            settings.add_row(GSettingsSwitch(_("Display the date"), "org.cinnamon.desktop.interface", "clock-show-date"))
            settings.add_row(GSettingsSwitch(_("Display seconds"), "org.cinnamon.desktop.interface", "clock-show-seconds"))
