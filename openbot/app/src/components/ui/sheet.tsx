import type * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IconX } from "@tabler/icons-react";

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-[var(--duet-dur-sheet)] data-ending-style:duration-[var(--duet-dur-enter)] data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

/**
 * How a sheet crosses the screen. It slides in from wholly past its edge on the strong ease-out, at
 * the sheet duration, and goes back out a step quicker, with the backdrop fading on the same clock.
 *
 * NO FADE ON THE PANEL ITSELF. It used to fade in while sliding the last 2.5rem, and for the first
 * frames the drawer's rows lay half-transparent over the screen they were covering, two pages read
 * through each other. A panel that starts off the screen is never seen partly drawn. With reduced
 * motion there is no slide, and the panel fades instead, at the swap duration.
 */
const SHEET_MOTION =
  "transition-[translate,opacity] ease-[var(--duet-ease-out)] motion-safe:duration-[var(--duet-dur-sheet)] motion-safe:data-ending-style:duration-[var(--duet-dur-enter)] motion-reduce:duration-[var(--duet-dur-swap)] motion-reduce:data-starting-style:opacity-0 motion-reduce:data-ending-style:opacity-0 data-[side=bottom]:motion-safe:data-starting-style:translate-y-full data-[side=bottom]:motion-safe:data-ending-style:translate-y-full data-[side=top]:motion-safe:data-starting-style:-translate-y-full data-[side=top]:motion-safe:data-ending-style:-translate-y-full data-[side=left]:motion-safe:data-starting-style:-translate-x-full data-[side=left]:motion-safe:data-ending-style:-translate-x-full data-[side=right]:motion-safe:data-starting-style:translate-x-full data-[side=right]:motion-safe:data-ending-style:translate-x-full";

/**
 * Floats the sheet a few pixels in from the screen's edges, with its own border and rounded corners,
 * instead of running flush to them. Every rule is keyed on both `data-side` and `data-variant`, so it
 * outranks the single-attribute edge rules above it whatever order Tailwind writes them in.
 */
const INSET_CLASSES =
  "data-[variant=inset]:rounded-xl data-[variant=inset]:border data-[side=right]:data-[variant=inset]:inset-y-2 data-[side=right]:data-[variant=inset]:right-2 data-[side=right]:data-[variant=inset]:h-auto data-[side=left]:data-[variant=inset]:inset-y-2 data-[side=left]:data-[variant=inset]:left-2 data-[side=left]:data-[variant=inset]:h-auto data-[side=top]:data-[variant=inset]:inset-x-2 data-[side=top]:data-[variant=inset]:top-2 data-[side=bottom]:data-[variant=inset]:inset-x-2 data-[side=bottom]:data-[variant=inset]:bottom-2";

function SheetContent({
  className,
  children,
  side = "right",
  variant = "default",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left";
  /** `inset` floats the sheet in from the edges; `default` runs it flush to them. */
  variant?: "default" | "inset";
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        data-variant={variant}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          SHEET_MOTION,
          INSET_CLASSES,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <IconX />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
