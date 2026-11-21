import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

// Temporary home page. The real one-page landing site is built in Phase 9.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Post every week without filming every week.
      </h1>
      <p className="text-muted-foreground max-w-md">
        Record one clip. Approve your plan. Get finished reels every week.
      </p>
      <Link href="/login" className={buttonVariants({ size: "lg" })}>
        Log in
      </Link>
    </main>
  );
}
