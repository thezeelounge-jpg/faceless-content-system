import { Suspense } from "react";
import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isGoogleLoginEnabled } from "@/lib/config";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/safe-redirect";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in · Creator Tool" };

const ERROR_MESSAGES: Record<string, string> = {
  link: "That login link has expired or was already used. Send yourself a new one.",
  google: "Google login didn't work. Try the email link instead.",
};

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  const googleEnabled = isGoogleLoginEnabled();
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Log in</CardTitle>
          <CardDescription>We’ll email you a link. No password needed.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<LoginForm next={DEFAULT_AFTER_LOGIN} googleEnabled={googleEnabled} />}>
            <LoginFormWithParams searchParams={searchParams} googleEnabled={googleEnabled} />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}

async function LoginFormWithParams({
  searchParams,
  googleEnabled,
}: {
  searchParams: PageProps<"/login">["searchParams"];
  googleEnabled: boolean;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const errorKey = first(params.error);
  return (
    <LoginForm
      next={next}
      googleEnabled={googleEnabled}
      initialError={errorKey ? ERROR_MESSAGES[errorKey] : undefined}
    />
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
