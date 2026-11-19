"use client";

import dynamic from "next/dynamic";

// The import (file reading, column mapping, preview) is only code an admin who imports needs: its own chunk. Declared
// in a client module because next/dynamic in the server page kept it in the page's first load.
export const AiImportAdmin = dynamic(() => import("@/components/admin/AiImportAdmin").then((m) => m.AiImportAdmin));
