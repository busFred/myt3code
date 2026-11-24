import {
  DesktopCloseWindowBehaviorSchema,
  type DesktopCloseWindowBehavior,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const isCloseWindowBehavior = Schema.is(DesktopCloseWindowBehaviorSchema);

export function DesktopAppSection() {
  const gt = useGT();
  if (!window.desktopBridge?.setCloseWindowBehavior) return null;
  return (
    <SettingsSection id="desktop-app" title={gt("Desktop app")}>
      <CloseWindowBehaviorSetting />
    </SettingsSection>
  );
}

function CloseWindowBehaviorSetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const bridge = window.desktopBridge;
  const labels = {
    ask: gt("Always ask"),
    tray: gt("Hide to system tray"),
    "app-only": gt("Quit app only"),
    "app-and-service": gt("Quit app and service"),
  } satisfies Record<DesktopCloseWindowBehavior, string>;
  const [behavior, setBehavior] = useState(() => bridge?.getCloseWindowBehavior?.() ?? "ask");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!bridge?.setCloseWindowBehavior) return null;
  const options = Object.entries(labels).filter(
    ([value]) => value !== "tray" || bridge.supportsTray === true,
  );
  const save = async (value: unknown) => {
    if (!isCloseWindowBehavior(value)) return;
    setSaving(true);
    setError(null);
    try {
      await bridge.setCloseWindowBehavior(value);
      setBehavior(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Couldn't change this setting."));
    }
    setSaving(false);
  };
  return (
    <SettingsRow
      {...searchableSetting("close-window-behavior")}
      description={error ?? gt("What happens when you close the T3 Code window.")}
      control={
        <Select value={behavior} onValueChange={(value) => void save(value)}>
          <SelectTrigger size="sm" disabled={saving} aria-label={gt("Close window behavior")}>
            <SelectValue>{labels[behavior]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            {options.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
