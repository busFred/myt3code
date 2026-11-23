import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { T, useGT } from "gt-react";
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
import { useSearchableSetting } from "./settingsSearch";

// Toggling relaunches desktop; the switch reflects startup state.
export function LocalEnvironmentSetting() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
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
      setError(
        cause instanceof Error
          ? (thrownErrorMessage(cause, m) ?? cause.message)
          : gt("Couldn't change this setting."),
      );
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("local-environment")}
        description={
          enabled
            ? gt(
                "Run agents on this computer. Turn off to use T3 Code only with remote environments.",
              )
            : gt("Turned off. Agents only run in remote environments.")
        }
        control={
          <Switch
            checked={enabled}
            disabled={isUpdating}
            onCheckedChange={() => setConfirmOpen(true)}
            aria-label={gt("Local environment")}
          />
        }
      />
      <CloseToTraySetting />
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
              {enabled ? gt("Turn off local environment?") : gt("Turn on local environment?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? gt(
                    "T3 Code will restart without running a server on this computer. Any agents and terminals running here will stop, and other devices will no longer be able to connect to this computer. Your projects, history, and remote environments are unaffected.",
                  )
                : gt("T3 Code will restart and start running a server on this computer again.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant={enabled ? "destructive" : "default"}
              disabled={isUpdating}
              onClick={() => void applyChange()}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" />
                  <T>Restarting…</T>
                </>
              ) : enabled ? (
                gt("Restart and turn off")
              ) : (
                gt("Restart and turn on")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const isServiceQuitBehavior = Schema.is(DesktopServiceQuitBehaviorSchema);

function ServiceQuitSetting() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const SERVICE_QUIT_LABELS = {
    ask: gt("Ask every time"),
    "app-only": gt("Quit app only"),
    "app-and-service": gt("Quit app and stop service"),
  } satisfies Record<DesktopServiceQuitBehavior, string>;
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
      setError(cause instanceof Error ? cause.message : gt("Couldn't save quit behavior."));
    }
    setSaving(false);
  };
  return (
    <SettingsRow
      {...searchableSetting("service-quit-behavior")}
      description={
        error ?? gt("Choose whether the background service keeps running after you quit the app.")
      }
      control={
        <Select value={behavior} onValueChange={(value) => void save(value)}>
          <SelectTrigger
            size="sm"
            disabled={saving}
            aria-label={gt("When quitting while connected to the background service")}
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
        gt(
          "Closing the window keeps T3 Code running in the system tray. Use the tray icon to show it again or quit. On GNOME, tray icons need the AppIndicator extension; launching T3 Code again also brings the window back.",
        )
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
