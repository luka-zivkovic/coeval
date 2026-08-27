import { Database } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHead } from "@/components/coeval";

export function DatabaseModeRequired({
  eyebrow,
  title,
  description,
  demoAlternative,
}: {
  eyebrow: string;
  title: string;
  description: string;
  demoAlternative: string;
}) {
  return (
    <div className="fadeUp max-w-[960px]">
      <SectionHead eyebrow={eyebrow} title={title} sub={description} />
      <Card className="border-dashed">
        <CardContent className="flex items-start gap-3 py-5">
          <Database className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden="true" />
          <div>
            <div className="font-serif text-[14.5px] font-medium text-ink">
              Persistent signed-in workspace required
            </div>
            <p className="mt-1 text-[12.5px] leading-[1.6] text-ink-3">
              This workflow must save reviewer identity, project membership, and evidence history.
              The in-memory demo cannot preserve those records. Configure Postgres and sign in to use it.
            </p>
            <p className="mt-2 text-[11.5px] leading-[1.55] text-ink-3">{demoAlternative}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
