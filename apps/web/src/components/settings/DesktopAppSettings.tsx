import { useGT } from "gt-react";
import { useState } from "react";

import { isWindowsPlatform } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

// Only Windows and Linux get the bridge methods, since the Dock keeps a macOS app alive.
export function DesktopAppSection() {
  const gt = useGT();
  if (!window.desktopBridge?.setCloseToTray) return null;
  return (
    <SettingsSection id="desktop-app" title={gt("Desktop app")}>
      <CloseToTraySetting />
    </SettingsSection>
  );
}

function CloseToTraySetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const bridge = window.desktopBridge;
  const [enabled, setEnabled] = useState(() => bridge?.getCloseToTray?.() ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setCloseToTray = bridge?.setCloseToTray;
  if (!setCloseToTray) return null;
  const save = async (value: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await setCloseToTray(value);
      setEnabled(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Couldn't change this setting."));
    }
    setSaving(false);
  };
  return (
    <SettingsRow
      {...searchableSetting("close-to-tray")}
      description={
        error ??
        (isWindowsPlatform(navigator.platform)
          ? gt(
              "Closing the window keeps T3 Code running in the system tray. Use the tray icon to show it again or quit. The icon may be under the ^ arrow on the taskbar.",
            )
          : gt(
              "Closing the window keeps T3 Code running in the system tray. Use the tray icon to show it again or quit. On GNOME, tray icons need the AppIndicator extension; launching T3 Code again also brings the window back.",
            ))
      }
      control={
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={(checked) => void save(checked)}
          aria-label={gt("Close to system tray")}
        />
      }
    />
  );
}
