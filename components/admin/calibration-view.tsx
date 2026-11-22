import { Card, CardContent } from "@/components/ui/card";
import { CALIBRATION } from "@/lib/qa/config";
import type { CalibrationResult } from "@/lib/qa/calibration";

// p5-b3: calibration, READ ONLY. Shows; never changes a threshold (no form, no button, no action).

export function CalibrationView({ result }: { result: CalibrationResult }) {
  if (!result.ready) {
    return (
      <Card>
        <CardContent className="space-y-1 text-sm">
          <p>
            {result.realVideos} of {CALIBRATION.min_real_videos} real videos so far. Calibration starts after {result.needed} more.
          </p>
          <p className="text-muted-foreground">Only real HeyGen renders count; mock videos never count.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Read only. Based on {result.realVideos} real videos. Nothing changes until the owner agrees; then a person edits{" "}
          <code>lib/qa/config.ts</code>.
        </p>
        <ul className="divide-border divide-y">
          {result.gates.map((g) => (
            <li key={g.key} className="space-y-0.5 py-2">
              <p className="font-medium">{g.label}</p>
              <p>
                Current: {g.threshold} · Proposed: {g.proposed}
                {g.proposed !== g.threshold && <span className="text-destructive"> (change)</span>}
              </p>
              <p className="text-muted-foreground">
                {g.stats
                  ? `${g.count} scores: lowest ${g.stats.min}, middle ${g.stats.median}, highest ${g.stats.max}; ${g.passing} pass today.`
                  : "No scores yet."}
              </p>
              <p>{g.reasoning}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
