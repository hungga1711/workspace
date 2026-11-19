/**
 * Text reduced for matching: lower case, no Vietnamese tone marks, đ as d ("Đức Anh" and "duc anh" match). Lower-casing
 * first turns Đ into đ, so both cases fold. One character in, one out for Vietnamese text, so search can mark matches
 * at the same offsets in the original.
 */
export const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
