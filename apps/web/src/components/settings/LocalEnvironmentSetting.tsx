import {
  DesktopServiceQuitBehaviorSchema,
  type DesktopServiceQuitBehavior,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Toggling relaunches desktop; the switch reflects startup state.
export function LocalEnvironmentSetting() {
  const setEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  const [enabled] = useState(() => !isLocalEnvironmentDisabled());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!setEnabled) return null;

  const applyChange = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      await setEnabled(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("local-environment")}
        description={
          enabled
            ? "Run agents on this computer. Turn off to use T3 Code only with remote environments."
            : "Turned off. Agents only run in remote environments."
        }
        control={
          <Switch
            checked={enabled}
            disabled={isUpdating}
            onCheckedChange={() => setConfirmOpen(true)}
            aria-label="Local environment"
          />
        }
      />
      <ServiceQuitSetting />
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (isUpdating) return;
          setConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {enabled ? "Turn off local environment?" : "Turn on local environment?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? "T3 Code will restart without running a server on this computer. Any agents and terminals running here will stop, and other devices will no longer be able to connect to this computer. Your projects, history, and remote environments are unaffected."
                : "T3 Code will restart and start running a server on this computer again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant={enabled ? "destructive" : "default"}
              disabled={isUpdating}
              onClick={() => void applyChange()}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : enabled ? (
                "Restart and turn off"
              ) : (
                "Restart and turn on"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const isServiceQuitBehavior = Schema.is(DesktopServiceQuitBehaviorSchema);

const SERVICE_QUIT_LABELS = {
  ask: "Ask every time",
  "app-only": "Quit app only",
  "app-and-service": "Quit app and stop service",
} satisfies Record<DesktopServiceQuitBehavior, string>;

function ServiceQuitSetting() {
  const bridge = window.desktopBridge;
  const [behavior, setBehavior] = useState(() => bridge?.getServiceQuitBehavior?.() ?? "ask");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!bridge?.setServiceQuitBehavior) return null;
  const save = async (value: unknown) => {
    if (!isServiceQuitBehavior(value)) return;
    setSaving(true);
    setError(null);
    try {
      await bridge.setServiceQuitBehavior(value);
      setBehavior(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save quit behavior.");
    }
    setSaving(false);
  };
  return (
    <SettingsRow
      {...searchableSetting("service-quit-behavior")}
      description={
        error ?? "Choose whether the background service keeps running after you quit the app."
      }
      control={
        <Select value={behavior} onValueChange={(value) => void save(value)}>
          <SelectTrigger
            size="sm"
            disabled={saving}
            aria-label="When quitting while connected to the background service"
          >
            <SelectValue>{SERVICE_QUIT_LABELS[behavior]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            {Object.entries(SERVICE_QUIT_LABELS).map(([value, label]) => (
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
