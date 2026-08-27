import { useState } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/auth-client";
import { forgetFirstProjectKey } from "@/lib/journey";

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const result = await signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? "Sign-in failed");
      return;
    }
    // A previous user's one-time project key may still sit in this tab's
    // sessionStorage; a fresh identity must never inherit it.
    forgetFirstProjectKey();
    window.location.reload();
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <Card className="w-full max-w-md">
        <CardHeader className="flex-col items-start gap-1.5">
          <CardTitle className="text-[20px]">Log in to Coeval</CardTitle>
          <CardDescription>Public sign-up is disabled. Use an owner-created invite.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="email@example.com"
              type="email"
              required
            />
            <Input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              type="password"
              required
            />
            {error ? <p className="text-[12px] text-signal">{error}</p> : null}
            <Button type="submit" variant="primary" className="mt-1 self-start">
              <LogIn /> Log in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
