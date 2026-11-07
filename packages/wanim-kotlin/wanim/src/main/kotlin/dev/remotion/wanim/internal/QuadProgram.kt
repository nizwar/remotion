package dev.remotion.wanim.internal

import android.opengl.GLES30
import dev.remotion.wanim.WanimException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** One shader and one static buffer: Every frame is a single textured quad. */
internal class QuadProgram {
    private val program: Int
    private val buffers = IntArray(1)
    private val vertexArrays = IntArray(1)
    private val quadUniform: Int
    private val uvUniform: Int

    init {
        val vertexShader = compile(GLES30.GL_VERTEX_SHADER, VERTEX_SHADER)
        val fragmentShader = compile(GLES30.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
        program = GLES30.glCreateProgram()
        GLES30.glAttachShader(program, vertexShader)
        GLES30.glAttachShader(program, fragmentShader)
        GLES30.glLinkProgram(program)
        GLES30.glDeleteShader(vertexShader)
        GLES30.glDeleteShader(fragmentShader)
        val status = IntArray(1)
        GLES30.glGetProgramiv(program, GLES30.GL_LINK_STATUS, status, 0)
        if (status[0] == 0) {
            throw WanimException.Rendering("Could not link shader: ${GLES30.glGetProgramInfoLog(program)}")
        }
        quadUniform = GLES30.glGetUniformLocation(program, "uQuad")
        uvUniform = GLES30.glGetUniformLocation(program, "uUv")

        val corners = ByteBuffer.allocateDirect(CORNERS.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        corners.put(CORNERS).position(0)
        GLES30.glGenVertexArrays(1, vertexArrays, 0)
        GLES30.glBindVertexArray(vertexArrays[0])
        GLES30.glGenBuffers(1, buffers, 0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, buffers[0])
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, CORNERS.size * 4, corners, GLES30.GL_STATIC_DRAW)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glVertexAttribPointer(0, 2, GLES30.GL_FLOAT, false, 0, 0)

        GLES30.glUseProgram(program)
        GLES30.glUniform1i(GLES30.glGetUniformLocation(program, "uAtlas"), 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glClearColor(0f, 0f, 0f, 0f)
    }

    fun setOpaque(opaque: Boolean) {
        if (opaque) {
            GLES30.glDisable(GLES30.GL_BLEND)
        } else {
            GLES30.glEnable(GLES30.GL_BLEND)
            GLES30.glBlendFunc(GLES30.GL_ONE, GLES30.GL_ONE_MINUS_SRC_ALPHA)
        }
    }

    fun clear() {
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
    }

    fun drawSprite(
        texture: Int,
        atlas: WanimAtlasInfo,
        sprites: IntArray,
        base: Int,
        layout: WanimLayout,
        viewWidth: Int,
        viewHeight: Int,
    ) {
        val x = sprites[base + WanimManifest.SPRITE_X].toFloat()
        val y = sprites[base + WanimManifest.SPRITE_Y].toFloat()
        val w = sprites[base + WanimManifest.SPRITE_W].toFloat()
        val h = sprites[base + WanimManifest.SPRITE_H].toFloat()
        val left = layout.originX + sprites[base + WanimManifest.SPRITE_DX] * layout.scaleX
        val top = layout.originY + sprites[base + WanimManifest.SPRITE_DY] * layout.scaleY

        // In clip space, y points up and the view has a size of 2
        GLES30.glUniform4f(
            quadUniform,
            left * 2f / viewWidth - 1f,
            1f - top * 2f / viewHeight,
            w * layout.scaleX * 2f / viewWidth,
            -h * layout.scaleY * 2f / viewHeight,
        )

        val insetX = if (layout.scaleX == 1f) 0f else 0.5f
        val insetY = if (layout.scaleY == 1f) 0f else 0.5f
        GLES30.glUniform4f(
            uvUniform,
            (x + insetX) / atlas.width,
            (y + insetY) / atlas.height,
            (x + w - insetX) / atlas.width,
            (y + h - insetY) / atlas.height,
        )

        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun compile(type: Int, source: String): Int {
        val shader = GLES30.glCreateShader(type)
        GLES30.glShaderSource(shader, source)
        GLES30.glCompileShader(shader)
        val status = IntArray(1)
        GLES30.glGetShaderiv(shader, GLES30.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) {
            throw WanimException.Rendering("Could not compile shader: ${GLES30.glGetShaderInfoLog(shader)}")
        }
        return shader
    }

    private companion object {
        val CORNERS = floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f)

        const val VERTEX_SHADER = """#version 300 es
layout(location = 0) in vec2 aCorner;
uniform vec4 uQuad;
uniform vec4 uUv;
out highp vec2 vUv;
void main() {
    vUv = mix(uUv.xy, uUv.zw, aCorner);
    gl_Position = vec4(uQuad.xy + aCorner * uQuad.zw, 0.0, 1.0);
}
"""

        const val FRAGMENT_SHADER = """#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in highp vec2 vUv;
out vec4 color;
void main() {
    color = texture(uAtlas, vUv);
}
"""
    }
}
