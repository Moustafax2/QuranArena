import { Loader2 } from "lucide-react";

const SIZE_CLASSES = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-8 w-8",
} as const;

export function Spinner({
  size = "md",
  className = "",
}: {
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  return <Loader2 aria-hidden="true" className={`animate-spin ${SIZE_CLASSES[size]} ${className}`} />;
}
