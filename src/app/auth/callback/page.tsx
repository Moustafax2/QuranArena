import { Button } from "@/components/ui/Button";

export default function AuthCallbackPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center text-white">
      <h1 className="text-3xl font-bold">This page isn&apos;t meant to be visited directly</h1>
      <p className="mt-4 text-gray-400">
        If you were trying to sign in, start from the login page.
      </p>
      <Button href="/login" className="mt-8">
        Go to login
      </Button>
    </div>
  );
}
