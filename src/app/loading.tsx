import { Spinner } from "@/components/ui/Spinner";

export default function Loading() {
  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-gray-950">
      <Spinner size="lg" className="text-emerald-500" />
    </div>
  );
}
