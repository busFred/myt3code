import type { DesktopUpstreamRelease } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/** Announces a newer upstream release. The link only opens its page; nothing is installed. */
export function UpstreamReleaseNotice() {
  const gt = useGT();
  const [release, setRelease] = useState<DesktopUpstreamRelease | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the desktop to check upstream each time Settings → About opens
  useEffect(() => {
    let cancelled = false;
    void window.desktopBridge
      ?.getUpstreamRelease()
      .then((found) => {
        if (!cancelled) setRelease(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!release) return null;
  return (
    <SettingsRow
      title={gt("Upstream release")}
      description={gt("Upstream T3 Code v{version} is out. Update your fork to get it.", {
        version: release.version,
      })}
      control={
        <Button
          size="sm"
          variant="outline"
          render={<a href={release.url} target="_blank" rel="noreferrer noopener" />}
        >
          <T>View release</T>
        </Button>
      }
    />
  );
}
