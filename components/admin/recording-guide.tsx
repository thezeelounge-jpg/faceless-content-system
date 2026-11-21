import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadRecordingGuide } from "@/lib/recording-guide";

/** docs/RECORDING-GUIDE.md, shown on the consent pages (server component). */
export function RecordingGuide() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recording guide</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loadRecordingGuide().map((section, i) => (
          <section key={i}>
            {section.heading && <h3 className="font-medium">{section.heading}</h3>}
            <ul className="text-muted-foreground list-disc pl-5">
              {section.lines.map((line, j) => (
                <li key={j}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
