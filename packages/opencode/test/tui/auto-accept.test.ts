import { describe, expect, test, mock, beforeEach } from "bun:test"
import { createStore } from "solid-js/store"

describe("TUI sync auto-accept logic", () => {
  let store: any
  let setStore: any
  let sdkReplyMock: any

  beforeEach(() => {
    const [s, ss] = createStore({
      permission: {},
    })
    store = s
    setStore = ss
    sdkReplyMock = mock(() => Promise.resolve({}))
  })

  function handlePermissionAsked(event: any, currentAutoAccept: string) {
    const request = event.properties

    // Logic from sync.tsx (latest version)
    if (currentAutoAccept !== "none" && request.permission === "edit") {
      sdkReplyMock({
        reply: "once",
        requestID: request.id,
      })
      return
    }

    if (currentAutoAccept === "yolo" && request.permission === "external_directory") {
      sdkReplyMock({
        reply: "once",
        requestID: request.id,
      })
      return
    }

    if (currentAutoAccept === "autoreject" && request.permission === "external_directory") {
      sdkReplyMock({
        reply: "reject",
        requestID: request.id,
        message: "Access to another directory was rejected.",
      })
      return
    }

    // Default behavior
    const requests = store.permission[request.sessionID]
    if (!requests) {
      setStore("permission", request.sessionID, [request])
      return
    }
  }

  test("auto-accepts edit in 'edit' mode", () => {
    const event = {
      properties: {
        id: "perm_1",
        sessionID: "ses_1",
        permission: "edit",
      },
    }
    handlePermissionAsked(event, "edit")
    expect(sdkReplyMock).toHaveBeenCalledWith({
      reply: "once",
      requestID: "perm_1",
    })
  })

  test("auto-accepts edit in 'yolo' mode", () => {
    const event = {
      properties: {
        id: "perm_1",
        sessionID: "ses_1",
        permission: "edit",
      },
    }
    handlePermissionAsked(event, "yolo")
    expect(sdkReplyMock).toHaveBeenCalledWith({
      reply: "once",
      requestID: "perm_1",
    })
  })

  test("auto-accepts edit in 'autoreject' mode", () => {
    const event = {
      properties: {
        id: "perm_1",
        sessionID: "ses_1",
        permission: "edit",
      },
    }
    handlePermissionAsked(event, "autoreject")
    expect(sdkReplyMock).toHaveBeenCalledWith({
      reply: "once",
      requestID: "perm_1",
    })
  })

  test("auto-accepts external_directory in 'yolo' mode", () => {
    const event = {
      properties: {
        id: "perm_ext",
        sessionID: "ses_1",
        permission: "external_directory",
      },
    }
    handlePermissionAsked(event, "yolo")
    expect(sdkReplyMock).toHaveBeenCalledWith({
      reply: "once",
      requestID: "perm_ext",
    })
  })

  test("auto-rejects external_directory in 'autoreject' mode", () => {
    const event = {
      properties: {
        id: "perm_ext",
        sessionID: "ses_1",
        permission: "external_directory",
      },
    }
    handlePermissionAsked(event, "autoreject")
    expect(sdkReplyMock).toHaveBeenCalledWith({
      reply: "reject",
      requestID: "perm_ext",
      message: "Access to another directory was rejected.",
    })
  })

  test("does NOT auto-accept external_directory in 'edit' mode", () => {
    const event = {
      properties: {
        id: "perm_ext",
        sessionID: "ses_1",
        permission: "external_directory",
      },
    }
    handlePermissionAsked(event, "edit")
    expect(sdkReplyMock).not.toHaveBeenCalled()
    expect(store.permission["ses_1"]).toBeDefined()
  })
})
