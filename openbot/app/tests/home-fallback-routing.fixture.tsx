import { mock } from "bun:test";
import type { ReactNode } from "react";

mock.module("@/components/ui/carousel", () => ({
  Carousel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CarouselContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CarouselItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  CarouselNext: () => <button type="button">Next agents</button>,
  CarouselPrevious: () => <button type="button">Previous agents</button>,
}));
