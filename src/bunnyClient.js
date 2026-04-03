const fs = require('fs');
const axios = require('axios');

class BunnyStreamClient {
  constructor({ apiKey, libraryId }) {
    this.libraryId = String(libraryId);
    this.http = axios.create({
      baseURL: 'https://video.bunnycdn.com',
      timeout: 30000,
      headers: {
        AccessKey: apiKey
      }
    });
  }

  normalizeCollectionList(data) {
    if (Array.isArray(data)) {
      return data;
    }

    if (data && Array.isArray(data.items)) {
      return data.items;
    }

    if (data && Array.isArray(data.collections)) {
      return data.collections;
    }

    return [];
  }

  async listCollections() {
    const response = await this.http.get(`/library/${this.libraryId}/collections`);
    const rawItems = this.normalizeCollectionList(response.data);

    return rawItems.map((item) => {
      const id = item.guid || item.videoLibraryCollectionId || item.id;
      const name = item.name || item.title || `Collection ${id || 'Unknown'}`;

      return {
        id: id ? String(id) : '',
        name: String(name)
      };
    }).filter((item) => item.id);
  }

  async createCollection(name) {
    const response = await this.http.post(`/library/${this.libraryId}/collections`, {
      name
    });

    const data = response.data || {};
    const id = data.guid || data.videoLibraryCollectionId || data.id;
    if (!id) {
      throw new Error('Bunny create collection response did not include a collection ID.');
    }

    return {
      id: String(id),
      name: String(data.name || name)
    };
  }

  async createVideo(title, collectionId) {
    const payload = { title };
    if (collectionId) {
      payload.collectionId = collectionId;
    }

    const response = await this.http.post(`/library/${this.libraryId}/videos`, payload);

    const data = response.data || {};
    const videoId = data.guid || data.videoId || data.id;

    if (!videoId) {
      throw new Error('Bunny create video response did not include a video ID.');
    }

    return String(videoId);
  }

  async uploadVideo({ videoId, filePath, fileSize, onProgress }) {
    let uploadedBytes = 0;
    const fileStream = fs.createReadStream(filePath);

    fileStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      if (typeof onProgress === 'function') {
        onProgress(Math.min(uploadedBytes, fileSize), fileSize);
      }
    });

    try {
      await this.http.put(`/library/${this.libraryId}/videos/${videoId}`, fileStream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize
        },
        timeout: 0,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } catch (error) {
      fileStream.destroy();
      throw error;
    }
  }
}

module.exports = {
  BunnyStreamClient
};
