/**
 * usePermissions — derives write/read capability for a given resource owner
 * based on the current user's sub and Cognito group membership.
 *
 * Rules (mirror the backend _can_read / _can_write helpers):
 *   - own resource (owner === sub, or owner absent)  → always allowed
 *   - global-write                                    → read + write on anything
 *   - global-read                                     → read only on anything
 *   - otherwise                                       → denied on others' resources
 */
import { useMemo } from "react";
import { getUser } from "../auth";

export interface Permissions {
  /** Can the current user read (view) a resource with the given owner? */
  canRead: (owner?: string) => boolean;
  /** Can the current user mutate (edit/delete/focus) a resource with the given owner? */
  canWrite: (owner?: string) => boolean;
}

export function usePermissions(): Permissions {
  const user = getUser();

  return useMemo<Permissions>(() => {
    const sub = user?.sub ?? "";
    const groups = user?.groups ?? [];
    const globalWrite = groups.includes("global-write");
    const globalRead = groups.includes("global-read") || globalWrite;

    return {
      canRead: (owner?: string) =>
        !owner || owner === sub || globalRead,
      canWrite: (owner?: string) =>
        !owner || owner === sub || globalWrite,
    };
  }, [user?.sub, user?.groups?.join(",")]);  // eslint-disable-line react-hooks/exhaustive-deps
}
