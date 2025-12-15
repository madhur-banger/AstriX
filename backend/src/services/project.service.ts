import ProjectModel from "../models/project.model";
import TaskModel from "../models/task.model";
import { NotFoundException } from "../utils/appError";
import { workspaceIdSchema } from "../validation/workspace.validation";


export const createProjectService = async (
    userId: string,
    workspaceId: string,
    body: {
        emoji?: string;
        name: string;
        description?: string;
    }
) => {
    const project = new ProjectModel({
        ...(body.emoji && {emoji: body.emoji}),
        name: body.name,
        description: body.description,
        workspace: workspaceId,
        createdBy: userId,
    });

    await project.save();

    return { project };
    };


export const getProjectsInWorkspaceService = async(
    workspaceId: string,
    pageSize: number,
    pageNumber: number
) => {
    const totalCount = await ProjectModel.countDocuments({
        workspace: workspaceId,
    });

    const skip = (pageNumber - 1 ) * pageSize;

    const projects = await ProjectModel.find({
        workspace: workspaceId
    })
        .skip(skip)
        .limit(pageSize)
        .populate("createdBy", "_id name profilePicture -password")
        .sort({ createdAt: -1 });

    const totalPages = Math.ceil(totalCount / pageSize);

    return { projects, totalCount, totalPages, skip };
};

export const getProjectByIdAndWorkspaceIdService = async(
    workspaceId: string,
    projectId: string
) => {
    const project = await ProjectModel.findOne({
        _id: projectId,
        workspace: workspaceId
    }).select("_id emoji name description");

    if(!project){
        throw new NotFoundException(
            "Project not found or does not belong to specified workspace"
        );
    }

    return {project};
}




export const updateProjectService = async (
    workspaceId: string,
    projectId: string,
    body: {
      emoji?: string;
      name: string;
      description?: string;
    }
  ) => {
    const { name, emoji, description } = body;
  
    const project = await ProjectModel.findOne({
      _id: projectId,
      workspace: workspaceId,
    });
  
    if (!project) {
      throw new NotFoundException(
        "Project not found or does not belong to the specified workspace"
      );
    }
  
    if (emoji) project.emoji = emoji;
    if (name) project.name = name;
    if (description) project.description = description;
  
    await project.save();
  
    return { project };
  };


  export const deleteProjectService = async (
    workspaceId: string,
    projectId: string
  ) => {
    const project = await ProjectModel.findOne({
      _id: projectId,
      workspace: workspaceId,
    });
  
    if (!project) {
      throw new NotFoundException(
        "Project not found or does not belong to the specified workspace"
      );
    }
  
    await project.deleteOne();
  
    await TaskModel.deleteMany({
      project: project._id,
    });
  
    return project;
  };
  