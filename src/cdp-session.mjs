export class CdpSession {
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor(socket, { onEvent = () => {}, onClose = () => {} } = {}) {
    this.socket = socket;
    this.onEvent = onEvent;
    this.onClose = onClose;
    socket.addEventListener?.("message", (event) => this.#receive(event.data));
    socket.addEventListener?.("close", () => this.#handleClose());
    socket.on?.("message", (data) => this.#receive(data));
    socket.on?.("close", () => this.#handleClose());
  }

  send(method, params = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("CDP 会话已关闭"));
    }

    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.#pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  close() {
    this.#handleClose();
    this.socket.close?.();
  }

  #receive(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP 请求失败"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      this.onEvent(message.method, message.params);
    }
  }

  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) {
      reject(new Error("CDP 会话已关闭"));
    }
    this.#pending.clear();
    this.onClose();
  }
}
