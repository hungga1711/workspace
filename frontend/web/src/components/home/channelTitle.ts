/** A channel's written name ("Kỹ thuật") when it has one, else its handle ("ky-thuat"). */
export const channelTitle = (c: { name: string | null; displayName?: string | null }) => c.displayName || c.name;
