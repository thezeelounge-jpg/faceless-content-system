import { envStatus, isMockClaude, isMockHeygen, isMockStt } from "@/lib/config";

/** Shows which settings are filled in (names only, never values). */
export function EnvStatusList({ upToPhase }: { upToPhase?: number }) {
  const items = envStatus().filter((item) => upToPhase === undefined || item.phase <= upToPhase);
  return (
    <ul className="divide-border divide-y text-sm">
      {items.map((item) => (
        <li key={item.name} className="flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs">{item.name}</p>
            <p className="text-muted-foreground text-xs">
              {item.note} · Phase {item.phase}
            </p>
          </div>
          <span className={item.isSet ? "font-medium text-green-700 dark:text-green-400" : "text-muted-foreground"}>
            {item.isSet ? "Set" : "Missing"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function MockModeList() {
  const rows = [
    { name: "HeyGen videos", mock: isMockHeygen() },
    { name: "Speech-to-text", mock: isMockStt() },
    { name: "Claude (writing)", mock: isMockClaude() },
  ];
  return (
    <ul className="divide-border divide-y text-sm">
      {rows.map((row) => (
        <li key={row.name} className="flex items-center justify-between py-2">
          <span>{row.name}</span>
          <span className={row.mock ? "font-medium text-green-700 dark:text-green-400" : "font-medium text-amber-700 dark:text-amber-400"}>
            {row.mock ? "Mock (free)" : "REAL (spends money)"}
          </span>
        </li>
      ))}
    </ul>
  );
}
