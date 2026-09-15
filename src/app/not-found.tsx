import { Button } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-gray-950 px-4 text-center text-white">
      <p className="text-sm font-semibold uppercase tracking-wider text-emerald-400">404</p>
      <h1 className="mt-3 text-3xl font-bold sm:text-4xl">Page not found</h1>
      <p className="mt-3 max-w-md text-gray-400">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <Button href="/" className="mt-8">
        Back to home
      </Button>
    </div>
  );
}
