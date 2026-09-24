import * as http from "node:http";

export interface MockServerOptions {
  port?: number;
}

export class DeterministicMockServer {
  private server: http.Server | null = null;
  public port = 0;
  public url = "";
  public requestLog: Array<{ path: string; body: any; headers: http.IncomingHttpHeaders }> = [];

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        let bodyRaw = "";
        req.on("data", (chunk) => {
          bodyRaw += chunk;
        });

        req.on("end", () => {
          let parsedBody: any = null;
          try {
            parsedBody = JSON.parse(bodyRaw);
          } catch {}

          this.requestLog.push({
            path: req.url || "",
            body: parsedBody,
            headers: req.headers,
          });

          // Route: /v1/chat/completions
          if (req.url?.startsWith("/v1/chat/completions")) {
            const messages = parsedBody?.messages || [];
            const userContent = messages[messages.length - 1]?.content || "";

            // 1. Auto session title request
            if (typeof userContent === "string" && userContent.includes("Summarize the primary objective")) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  id: "mock-title-resp",
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: "Bangun Sistem Autentikasi Pengguna",
                      },
                    },
                  ],
                })
              );
              return;
            }

            // 2. By-the-way side question request
            if (typeof userContent === "string" && userContent.includes("Pertanyaan sampingan user")) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  id: "mock-btw-resp",
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content:
                          "useMemo digunakan untuk menyimpan nilai komputasi mahal, sedangkan useCallback digunakan untuk menstabilkan referensi fungsi antar render.",
                      },
                    },
                  ],
                })
              );
              return;
            }

            // 3. Planning request (/plan)
            if (typeof userContent === "string" && (userContent.includes("WORKFLOW MODE: /plan") || userContent.includes("Rancang rencana"))) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  id: "mock-plan-resp",
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: [
                          "Analisis kebutuhan selesai.",
                          "",
                          "```json",
                          JSON.stringify(
                            {
                              plan: {
                                steps: [
                                  "Setup database schema dan migrasi",
                                  "Implementasi endpoint autentikasi",
                                  "Buat unit test dan integrasi",
                                ],
                                risks: ["Token expiry mismatch", "Database deadlock"],
                                acceptanceCriteria: ["Login mengembalikan JWT 200", "Tes lulus 100%"],
                                verificationCommands: ["npm test"],
                              },
                            },
                            null,
                            2
                          ),
                          "```",
                          "Rencana siap disetujui via '/plan approve'.",
                        ].join("\n"),
                      },
                    },
                  ],
                })
              );
              return;
            }

            // Default fallback assistant response
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                id: "mock-default-resp",
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "Task berhasil dianalisis dan diproses.",
                    },
                  },
                ],
              })
            );
            return;
          }

          // Fallback 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Endpoint not found in mock server" }));
        });
      });

      // Bind to 127.0.0.1 on ephemeral port 0 (guaranteed free port)
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.url = `http://127.0.0.1:${this.port}`;
          resolve(this.url);
        } else {
          reject(new Error("Gagal memperoleh alamat mock server"));
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  clearLogs(): void {
    this.requestLog = [];
  }
}
