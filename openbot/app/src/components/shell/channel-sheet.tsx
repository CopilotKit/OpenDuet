import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation } from "@tanstack/react-query";
import {
  type ComponentProps,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  CHANNEL_COLOUR_LABELS,
  CHANNEL_GLYPHS,
  CHANNEL_ICON_LABELS,
  ChannelGlyph,
  channelColour,
} from "@/components/duet/channel-look";
import { useSheetPresence } from "@/hooks/use-sheet-presence";
import { appConfig } from "@/lib/generated/application-config";
import {
  archiveDuetChannelMutationOptions,
  createDuetChannelMutationOptions,
  type DuetChannelPatch,
  updateDuetChannelMutationOptions,
} from "@/lib/duet-channels/mutations";
import {
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  type ChannelColour,
  type ChannelIcon,
  type DuetChannel,
  MAX_CHANNEL_NAME,
  MAX_CHANNEL_PURPOSE,
  NEW_CHANNEL_COLOUR,
  NEW_CHANNEL_ICON,
} from "@/lib/duet-channels/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** The look a new channel starts with, before the person picks one: mail, in the third colour. */
export const NEW_CHANNEL_LOOK: { icon: ChannelIcon; colour: ChannelColour } = {
  icon: NEW_CHANNEL_ICON,
  colour: NEW_CHANNEL_COLOUR,
};

/** The purpose field's placeholder, with the product's own name in it. */
export const PURPOSE_QUESTION = `What should ${appConfig.brand.productName} know about this channel?`;

/** A name is needed; a purpose is not. Each within its length. */
export function channelDraftReady(draft: { name: string; purpose: string }) {
  const name = draft.name.trim();
  return (
    name.length > 0 &&
    name.length <= MAX_CHANNEL_NAME &&
    draft.purpose.trim().length <= MAX_CHANNEL_PURPOSE
  );
}

/** A pill on glass, for the sheet's top bar and Change icon. */
function GlassPill({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      className={cn(
        "duet-glass inline-flex h-11 min-w-[86px] items-center justify-center rounded-full px-4 font-medium text-[17px] text-duet-ink shadow-duet-glass outline-none transition-[opacity,transform] focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      type="button"
      {...props}
    />
  );
}

/**
 * New channel, as a sheet that rises over the app: Cancel, the title and Create along the top; the
 * channel's icon, big, in its colour, which changes the moment a person taps; Change icon, which
 * opens a grid of line icons stroked in the chosen colour and a row of nine dots; then its name and
 * its purpose. Create waits for a name. The purpose is optional; it is what the Bot is told about
 * the channel on every turn there.
 *
 * The same sheet edits a channel from its own screen (`channel` set): "Edit channel" and Save, with
 * Archive or Unarchive at its foot.
 *
 * It rises from below the screen's edge over the veil, and sinks back before the parent hears that
 * it closed, saved or archived (use-sheet-presence.ts). With reduced motion it fades in place.
 */
export function ChannelSheet({
  botId,
  channel,
  onClose: closed,
  onSaved: saved,
  onArchived: archived,
}: {
  botId: string;
  /** The channel being edited. Absent, the sheet makes a new one. */
  channel?: DuetChannel;
  /** Dismissed, once the sheet has gone. */
  onClose: () => void;
  /** Made or saved, with the channel as the server now has it, once the sheet has gone. */
  onSaved: (channel: DuetChannel) => void;
  /** Archived or brought back from the sheet, once the sheet has gone. */
  onArchived?: (channel: DuetChannel) => void;
}) {
  const editing = channel !== undefined;
  const presence = useSheetPresence();
  const onClose = () => presence.close(closed);
  const onSaved = (next: DuetChannel) => presence.close(() => saved(next));
  const onArchived = archived
    ? (next: DuetChannel) => presence.close(() => archived(next))
    : undefined;
  const [icon, setIcon] = useState<ChannelIcon>(
    channel?.icon ?? NEW_CHANNEL_LOOK.icon,
  );
  const [colour, setColour] = useState<ChannelColour>(
    channel?.colour ?? NEW_CHANNEL_LOOK.colour,
  );
  const [name, setName] = useState(channel?.name ?? "");
  const [purpose, setPurpose] = useState(channel?.purpose ?? "");
  const [picking, setPicking] = useState(false);
  /** Escape or a tap outside met typed fields, so the sheet asks before dropping them. */
  const [confirming, setConfirming] = useState(false);
  const changeIcon = useRef<HTMLButtonElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const purposeField = useRef<HTMLTextAreaElement>(null);
  const create = useMutation(createDuetChannelMutationOptions(queryClient));
  const update = useMutation(updateDuetChannelMutationOptions(queryClient));
  const archive = useMutation(archiveDuetChannelMutationOptions(queryClient));
  const busy = create.isPending || update.isPending || archive.isPending;
  const error = create.error ?? update.error ?? archive.error;
  const ready = channelDraftReady({ name, purpose });
  const pickerId = useId();
  const nameId = useId();
  const purposeId = useId();
  const title = editing ? "Edit channel" : "New channel";
  /*
   * Whether there is anything typed or chosen that leaving would lose: for a new channel, a name
   * or a purpose; for one being edited, anything that differs from what it is now.
   */
  const dirty = channel
    ? name.trim() !== channel.name ||
      purpose.trim() !== (channel.purpose ?? "") ||
      icon !== channel.icon ||
      colour !== channel.colour
    : name.trim() !== "" || purpose.trim() !== "";

  /**
   * ESCAPE, AND A TAP OUTSIDE, CLOSE THE INNERMOST THING AND NEVER DROP WHAT WAS TYPED.
   *
   * The sheet used to close on either, whatever was open inside it: Escape pressed to fold the icon
   * picker threw away the name and the purpose with it, without a word. Now the first press folds
   * the picker (and puts focus back on Change icon), and a sheet with something typed in it asks
   * "Discard this channel?" rather than closing; Escape again answers Keep editing. Only a sheet
   * with nothing to lose closes straight away. Cancel is unchanged: it is the person saying discard.
   */
  const dismiss = () => {
    if (confirming) {
      setConfirming(false);
      return;
    }
    if (picking) {
      setPicking(false);
      changeIcon.current?.focus();
      return;
    }
    if (dirty) {
      setConfirming(true);
      return;
    }
    onClose();
  };

  const save = () => {
    if (!ready || busy) return;
    if (!channel) {
      create.mutate(
        { botId, name: name.trim(), purpose: purpose.trim(), icon, colour },
        { onSuccess: onSaved },
      );
      return;
    }
    const patch: DuetChannelPatch = {};
    if (name.trim() !== channel.name) patch.name = name.trim();
    if (purpose.trim() !== (channel.purpose ?? ""))
      patch.purpose = purpose.trim();
    if (icon !== channel.icon) patch.icon = icon;
    if (colour !== channel.colour) patch.colour = colour;
    update.mutate({ id: channel.id, patch }, { onSuccess: onSaved });
  };

  return (
    <DialogPrimitive.Root
      onOpenChange={(next, details) => {
        if (next || busy) return;
        if (
          details.reason === "escape-key" ||
          details.reason === "outside-press"
        ) {
          dismiss();
          return;
        }
        onClose();
      }}
      onOpenChangeComplete={presence.onOpenChangeComplete}
      open={presence.open}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="duet-veil fixed inset-0 z-50 transition-opacity duration-[var(--duet-dur-sheet)] data-ending-style:duration-[var(--duet-dur-enter)] data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          className={cn(
            "duet-face fixed inset-x-0 top-[max(env(safe-area-inset-top),12px)] bottom-0 z-50 mx-auto flex w-full max-w-[430px] flex-col overflow-y-auto rounded-t-[38px] bg-duet-surface px-4 pb-[max(env(safe-area-inset-bottom),16px)] text-duet-ink shadow-duet-raised outline-none",
            "transition-[opacity,translate] motion-safe:duration-[var(--duet-dur-sheet)] motion-safe:data-ending-style:duration-[var(--duet-dur-enter)] motion-safe:data-ending-style:translate-y-full motion-safe:data-starting-style:translate-y-full motion-reduce:duration-[var(--duet-dur-swap)] motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:opacity-0",
          )}
          initialFocus={editing ? undefined : nameField}
        >
          <form
            className="flex flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="mt-4 grid h-11 grid-cols-[1fr_auto_1fr] items-center gap-2">
              <GlassPill
                className="justify-self-start"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </GlassPill>
              <DialogPrimitive.Title className="font-semibold text-[17px]">
                {title}
              </DialogPrimitive.Title>
              <GlassPill
                aria-busy={busy || undefined}
                className="justify-self-end"
                disabled={busy || !ready}
                type="submit"
              >
                {create.isPending || update.isPending ? (
                  <span
                    aria-label={editing ? "Saving" : "Creating"}
                    className="size-4 animate-spin rounded-full border-2 border-duet-ink-3 border-t-duet-ink motion-reduce:animate-none"
                    role="status"
                  />
                ) : editing ? (
                  "Save"
                ) : (
                  "Create"
                )}
              </GlassPill>
            </div>
            {error ? (
              <p
                className="type-label mt-3 px-1 text-center text-duet-red"
                role="alert"
              >
                {error.message}
              </p>
            ) : null}
            {confirming ? (
              <ConfirmDiscard
                editing={editing}
                keepRef={keepEditing}
                onDiscard={onClose}
                onKeep={() => {
                  setConfirming(false);
                  nameField.current?.focus();
                }}
              />
            ) : null}

            <div className="mt-10 flex flex-col items-center gap-3">
              <span data-testid="channel-preview">
                <ChannelGlyph
                  colour={colour}
                  icon={icon}
                  size={64}
                  stroke={1.6}
                />
              </span>
              <GlassPill
                aria-controls={pickerId}
                aria-expanded={picking}
                className="h-[34px] min-w-0 text-[15px]"
                onClick={() => setPicking((open) => !open)}
                ref={changeIcon}
              >
                Change icon
              </GlassPill>
            </div>

            <div className="mt-4" hidden={!picking} id={pickerId}>
              {/*
               * Native radios, one set per question, so the keyboard moves through a set with its
               * arrows as any radio group does. Each is hidden behind what it draws. Every glyph is
               * stroked in the chosen colour, so a new colour recolours the grid.
               */}
              <fieldset className="grid grid-cols-8 justify-items-center gap-y-1">
                <legend className="sr-only">Icon</legend>
                {CHANNEL_ICONS.map((option) => {
                  const Glyph = CHANNEL_GLYPHS[option];
                  const on = option === icon;
                  return (
                    <label
                      className="grid size-11 cursor-pointer place-items-center rounded-[10px] has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-duet-violet/40"
                      key={option}
                      style={{
                        color: channelColour(colour),
                        boxShadow: on
                          ? "inset 0 0 0 2px var(--duet-ink)"
                          : undefined,
                      }}
                    >
                      <input
                        aria-label={CHANNEL_ICON_LABELS[option]}
                        checked={on}
                        className="sr-only"
                        name={`${pickerId}-icon`}
                        onChange={() => setIcon(option)}
                        type="radio"
                        value={option}
                      />
                      <Glyph size={26} stroke={1.8} />
                    </label>
                  );
                })}
              </fieldset>
              <fieldset className="mt-3 flex items-center">
                <legend className="sr-only">Colour</legend>
                {CHANNEL_COLOURS.map((option) => {
                  const on = option === colour;
                  return (
                    <label
                      className="grid h-11 min-w-0 flex-1 cursor-pointer place-items-center rounded-full has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-duet-violet/40"
                      key={option}
                    >
                      <input
                        aria-label={CHANNEL_COLOUR_LABELS[option]}
                        checked={on}
                        className="sr-only"
                        name={`${pickerId}-colour`}
                        onChange={() => setColour(option)}
                        type="radio"
                        value={option}
                      />
                      <span
                        className="block size-7 rounded-full"
                        style={{
                          backgroundColor: channelColour(option),
                          boxShadow: on
                            ? "0 0 0 3px var(--duet-surface), 0 0 0 5px var(--duet-ink)"
                            : undefined,
                        }}
                      />
                    </label>
                  );
                })}
              </fieldset>
            </div>

            <label
              className="mt-6 flex h-14 items-center gap-3 rounded-full bg-duet-tile px-4 focus-within:ring-3 focus-within:ring-duet-violet/25"
              htmlFor={nameId}
            >
              <span className="shrink-0 text-[16px] text-duet-ink-2">Name</span>
              <input
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-[17px] text-duet-ink outline-none placeholder:text-duet-ink-3"
                disabled={busy}
                enterKeyHint="next"
                id={nameId}
                maxLength={MAX_CHANNEL_NAME}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  // Return moves on to the purpose, rather than creating the channel half told.
                  if (event.key === "Enter") {
                    event.preventDefault();
                    purposeField.current?.focus();
                  }
                }}
                placeholder="Q4 planning"
                ref={nameField}
                value={name}
              />
            </label>
            <label
              className="mt-5 px-4 text-[14px] text-duet-ink-2"
              htmlFor={purposeId}
            >
              Purpose
            </label>
            <textarea
              className="mt-1.5 min-h-24 w-full resize-none rounded-[22px] bg-duet-tile px-4 py-3 text-[17px] text-duet-ink leading-[23px] outline-none placeholder:text-duet-ink-3 focus-visible:ring-3 focus-visible:ring-duet-violet/25"
              disabled={busy}
              id={purposeId}
              maxLength={MAX_CHANNEL_PURPOSE}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder={PURPOSE_QUESTION}
              ref={purposeField}
              rows={3}
              value={purpose}
            />
            {channel && onArchived ? (
              <button
                className="type-label mt-6 self-center rounded-full px-3 py-1.5 font-semibold text-duet-ink-2 outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  archive.mutate(
                    { id: channel.id, archived: channel.archivedAt === null },
                    { onSuccess: onArchived },
                  )
                }
                type="button"
              >
                {channel.archivedAt === null
                  ? "Archive channel"
                  : "Unarchive channel"}
              </button>
            ) : null}
          </form>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The one question before typed fields are dropped: under the top bar, where the sheet's own error
 * line goes, with Keep editing first and focused, so a second Escape or a stray Return keeps them.
 */
function ConfirmDiscard({
  editing,
  keepRef,
  onKeep,
  onDiscard,
}: {
  editing: boolean;
  keepRef: RefObject<HTMLButtonElement | null>;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  useEffect(() => {
    keepRef.current?.focus();
  }, [keepRef]);
  return (
    <div
      aria-live="polite"
      className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-[22px] bg-duet-tile px-4 py-3"
    >
      <p className="type-label font-medium text-duet-ink">
        {editing ? "Discard your changes?" : "Discard this channel?"}
      </p>
      <div className="flex gap-2">
        <GlassPill
          className="h-[36px] min-w-0 text-[15px]"
          onClick={onKeep}
          ref={keepRef}
        >
          Keep editing
        </GlassPill>
        <GlassPill
          className="h-[36px] min-w-0 text-[15px] text-duet-red"
          onClick={onDiscard}
        >
          Discard
        </GlassPill>
      </div>
    </div>
  );
}
