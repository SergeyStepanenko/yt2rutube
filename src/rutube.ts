const RUTUBE_API = "https://rutube.ru/api";

interface RutubeToken {
  token: string;
}

interface UploadParams {
  url: string;
  title: string;
  description?: string;
  isHidden?: boolean;
  categoryId?: number;
  callbackUrl?: string;
}

interface UploadResult {
  videoId: string;
  raw: Record<string, any>;
}

export class RutubeClient {
  private token: string | null = null;

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(`${RUTUBE_API}/accounts/token_auth/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: email, password }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rutube auth failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as RutubeToken;
    this.token = data.token;
    console.log("Rutube: авторизация успешна");
  }

  private getHeaders(): Record<string, string> {
    if (!this.token) throw new Error("Not authenticated. Call login() first.");
    return {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async uploadByUrl(params: UploadParams): Promise<UploadResult> {
    const body: Record<string, any> = {
      url: params.url,
    };

    if (params.callbackUrl) {
      body.callback_url = params.callbackUrl;
    }

    const res = await fetch(`${RUTUBE_API}/video/`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rutube upload failed (${res.status}): ${text}`);
    }

    const data = await res.json() as Record<string, any>;
    const videoId = data.video_id ?? data.id ?? "";

    if (videoId && (params.title || params.description || params.isHidden !== undefined || params.categoryId)) {
      await this.patchVideo(videoId, {
        title: params.title?.slice(0, 100),
        description: (params.description ?? "").slice(0, 5000),
        is_hidden: params.isHidden ?? false,
        category_id: params.categoryId ?? 13,
      });
    }

    return { videoId, raw: data };
  }

  async getVideo(videoId: string): Promise<Record<string, any>> {
    const res = await fetch(`${RUTUBE_API}/video/${videoId}/`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rutube getVideo failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<Record<string, any>>;
  }

  async getMyVideos(page = 1, limit = 20): Promise<{ results: Record<string, any>[]; has_next: boolean }> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const res = await fetch(`${RUTUBE_API}/video/person/?${params}`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rutube getMyVideos failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<{ results: Record<string, any>[]; has_next: boolean }>;
  }

  async findMyVideoByTitle(title: string): Promise<Record<string, any> | null> {
    const normalizedTitle = title.slice(0, 100).trim().toLowerCase();
    let page = 1;

    while (true) {
      const data = await this.getMyVideos(page, 100);

      for (const video of data.results) {
        const vTitle = (video.title as string || "").trim().toLowerCase();
        if (vTitle === normalizedTitle) return video;
      }

      if (!data.has_next) break;
      page++;
    }

    return null;
  }

  async patchVideo(
    videoId: string,
    fields: Partial<{
      title: string;
      description: string;
      is_hidden: boolean;
      category_id: number;
    }>
  ): Promise<Record<string, any>> {
    const res = await fetch(`${RUTUBE_API}/video/${videoId}/`, {
      method: "PATCH",
      headers: this.getHeaders(),
      body: JSON.stringify(fields),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rutube patchVideo failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<Record<string, any>>;
  }
}
